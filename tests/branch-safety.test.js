import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord } from '../core.js';
import {
  addUserDismissedGroup, bestAncestorState, chatLineage, clearUserDismissedGroupsFor, normalizeUserDismissedGroups,
  BRANCH_LINEAGE_VERSION, preserveUserNpcMetadata, recordBranchCheckpoint, reconcileBranchState
} from '../branch.js';

function user(text){return {is_user:true,is_system:false,name:'User',mes:text};}
function assistant(text){return {is_user:false,is_system:false,name:'AI',mes:text};}
function baseState(){return {npcs:[],candidates:[],pendingBackfills:[],dismissed:[],inlineCards:[],checkpoints:[],lineage:[],branchLineageVersion:BRANCH_LINEAGE_VERSION,socialGraph:{edges:[],unresolved:[]},turn:0,assistantSinceScan:0,lastScanAt:0,lastScannedMessageId:null,scanCount:0,processedOocMessageId:null,userDismissedGroups:[]};}

test('modern permanent deletion tombstone is id-based and does not erase a different homonym',()=>{
  const chat=[user('start'),assistant('later')];
  const state=baseState();
  const deleted=createNpcRecord('Mina'); deleted.id='npc_old_mina';
  const homonym=createNpcRecord('Mina'); homonym.id='npc_new_mina';
  state.npcs=[deleted,homonym];
  state.lineage=chatLineage([user('different')]);
  state.userDismissedGroups=addUserDismissedGroup([],deleted);
  const result=reconcileBranchState(state,chat,{explicitDivergence:0});
  assert.deepEqual(result.state.npcs.map(n=>n.id),['npc_new_mina']);
  assert.equal(result.state.dismissed.includes('mina'),false);
});

test('historical ids can be attached to one deletion tombstone for old branch snapshots',()=>{
  const deleted=createNpcRecord('Mina'); deleted.id='npc_current';
  const groups=addUserDismissedGroup([],deleted,{historicalNpcIds:['npc_interim']});
  assert.deepEqual(normalizeUserDismissedGroups(groups)[0].ids.sort(),['npc_current','npc_interim']);
});


test('one-message common prefix is insufficient for cross-chat inheritance',()=>{
  const shared=user('Shared opening');
  const parentChat=[shared,assistant('Parent continuation')];
  const parent=baseState();
  parent.npcs=[createNpcRecord('Mina')];
  recordBranchCheckpoint(parent,parentChat,0,'opening');
  const childChat=[shared,assistant('Different continuation')];
  const inherited=bestAncestorState({'chat:parent':parent},'chat:child',childChat);
  assert.equal(inherited,null);
});


test('branch metadata restore prefers exact id and refuses ambiguous homonym label fallback',()=>{
  const original=[user('Shared'),assistant('Scene A')];
  const state=baseState();
  const oldMina=createNpcRecord('Mina'); oldMina.id='npc_old'; oldMina.retentionProtected=true;
  const newMina=createNpcRecord('Mina'); newMina.id='npc_new'; newMina.retentionProtected=false;
  state.npcs=[oldMina,newMina];
  recordBranchCheckpoint(state,original,0,'rootish');
  const checkpoint=state.checkpoints.find(x=>x.messageId===0);
  checkpoint.snapshot.npcs=[structuredClone(newMina)];
  const changed=[user('Shared'),assistant('Scene B')];
  const result=reconcileBranchState(state,changed,{explicitDivergence:1});
  const restored=result.state.npcs.find(n=>n.id==='npc_new');
  assert.equal(Object.prototype.hasOwnProperty.call(restored,'importance'),false);
  assert.equal(restored.retentionProtected,false);
});

test('same-name different-id explicit add/import does not clear a modern deletion tombstone',()=>{
  const deleted=createNpcRecord('Mina'); deleted.id='npc_old';
  const groups=addUserDismissedGroup([],deleted);
  const homonym=createNpcRecord('Mina'); homonym.id='npc_new';
  const cleared=clearUserDismissedGroupsFor(groups,homonym,{modernByIdOnly:true});
  assert.equal(cleared.groups.length,1);
  assert.deepEqual(cleared.removedIds,[]);
  const resurrected=clearUserDismissedGroupsFor(groups,deleted,{modernByIdOnly:true});
  assert.equal(resurrected.groups.length,0);
  assert.deepEqual(resurrected.removedIds,['npc_old']);
});

test('metadata restore still supports a unique label fallback when an id legitimately changed',()=>{
  const restored=createNpcRecord('Mina'); restored.id='npc_old'; restored.importance=10; restored.manual=true;
  const current=createNpcRecord('Mina'); current.id='npc_new'; current.importance=77; current.manual=true; current.retentionProtected=true;
  const result=preserveUserNpcMetadata([restored],[current]);
  assert.equal(Object.prototype.hasOwnProperty.call(result[0],'importance'),false);
  assert.equal(Object.prototype.hasOwnProperty.call(result[0],'manual'),false);
  assert.equal(result[0].retentionProtected,true);
});


test('explicit manual name-based tombstone clearing remains available',()=>{
  const deleted=createNpcRecord('Mina'); deleted.id='npc_old'; deleted.aliases=['The Innkeeper'];
  const groups=addUserDismissedGroup([],deleted);
  const cleared=clearUserDismissedGroupsFor(groups,'Mina');
  assert.equal(cleared.groups.length,0);
  assert.ok(cleared.removedIds.includes('npc_old'));
  assert.ok(cleared.removedLabels.includes('the innkeeper'));
});

test('a swipe of the latest of six replies restores the state of the reply before it, from sidecar format 1 and from format 2 with packed checkpoints',async()=>{
  const {encodeStateFilePayload,decodeStateFilePayload}=await import('../storage-payload.js');
  const greeting=assistant('Greeting');
  const chat=[greeting];
  const state=baseState();
  for(let reply=1;reply<=6;reply+=1){
    chat.push(user(`Turn ${reply}`));
    state.turn=reply;
    state.lineage=chatLineage(chat);
    recordBranchCheckpoint(state,chat,chat.length-1,'state');
    chat.push(assistant(`Reply ${reply} with enough text to be worth a patch against its neighbours, so that the middle entries pack.`));
    const mina=createNpcRecord('Mina'); mina.id='npc_mina'; mina.trust=reply; mina.notes=`seen in reply ${reply}`.repeat(reply);
    const crowd=Array.from({length:10},(_,at)=>{const npc=createNpcRecord(`Extra ${at}`); npc.id=`npc_extra_${at}`; npc.notes='A long unchanged note about this person that every checkpoint repeats. '.repeat(8); return npc;});
    state.npcs=[mina,...crowd];
    state.lineage=chatLineage(chat);
    recordBranchCheckpoint(state,chat,chat.length-1,'state');
  }
  const swiped=[...chat.slice(0,-1),assistant('Reply 6, swiped.')];
  const viaFile=version=>{
    const text=version===2?encodeStateFilePayload('chat:a.png:one',state):JSON.stringify({format:'npc_state_delta_chat_data',formatVersion:1,chatKey:'chat:a.png:one',revision:1,state:JSON.parse(JSON.stringify(state))});
    const written=JSON.parse(text);
    assert.equal(written.formatVersion,version);
    if(version===2) assert.equal(written.state.checkpoints.filter(entry=>!entry.snapshot).length>0,true,'packing is active: some checkpoints are on disk as patches');
    return decodeStateFilePayload(text).state;
  };
  for(const version of [1,2]){
    const loaded=viaFile(version);
    const result=reconcileBranchState(loaded,swiped,{explicitDivergence:swiped.length-1,operation:'swipe'});
    assert.equal(result.state.npcs[0].trust,5,`format ${version}: the state of reply 5, not reply 1 or reply 6`);
    assert.notEqual(result.state.npcs[0].trust,1);
  }
});
