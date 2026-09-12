from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


path = Path("index.js")
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    "} from './core.js';\nimport {\n    encodeNpcStateBundle,",
    "} from './core.js';\nimport { applyNpcBirthdayUpdate, normalizeBirthDate } from './birthday.js';\nimport {\n    encodeNpcStateBundle,",
    "birthday imports",
)
age = '        <label>Chronological age<input id="npc_state_delta_edit_age" class="text_pole" maxlength="80" placeholder="Actual stated age; leave blank if unknown" value="${editorValue(npc.age)}"></label>\n'
birthday = age + '        <label>Birthday <small>${npc.birthDateSource === \'generated\' ? \'Generated fallback; editing establishes a manual correction\' : (npc.birthDateSource === \'established\' ? \'Established date; editing records a manual correction\' : \'Uses the active calendar\')}</small><input id="npc_state_delta_edit_birthday" class="text_pole" maxlength="180" placeholder="MM-DD / YYYY-MM-DD or configured calendar date" value="${editorValue(npc.birthDateDisplay)}"></label>\n'
text = replace_once(text, age, birthday, "birthday field")
sync = "    set('npc_state_delta_edit_age', npc.age || '');\n"
text = replace_once(text, sync, sync + "    set('npc_state_delta_edit_birthday', npc.birthDateDisplay || '');\n", "birthday sync")
anchor = "    Object.assign(next, stableInputs);\n"
save = anchor + """    const birthdayInput = String(editorField('npc_state_delta_edit_birthday')).trim().slice(0, 180);
    const currentBirthdayDisplay = String(current.birthDateDisplay || '').trim();
    if (birthdayInput !== currentBirthdayDisplay) {
        if (!birthdayInput) {
            globalThis.toastr?.warning?.('NPC State Delta: birthday cannot be cleared here. Enter a valid date or cancel the edit.');
            return false;
        }
        const normalizedBirthday = normalizeBirthDate(birthdayInput);
        if (!normalizedBirthday) {
            globalThis.toastr?.warning?.('NPC State Delta: birthday is not valid for the active calendar.');
            return false;
        }
        const correctedBirthday = applyNpcBirthdayUpdate(next, {
            birthDate: normalizedBirthday,
            birthDateState: 'correct',
            birthDateReason: 'Manual dossier birthday correction.',
        });
        correctedBirthday.birthDateSourceMessageId = null;
        Object.assign(next, correctedBirthday);
    }
"""
text = replace_once(text, anchor, save, "birthday save")
path.write_text(text, encoding="utf-8")

tests = Path("tests/index-hardening.test.js")
test_text = tests.read_text(encoding="utf-8")
if "manual dossier editor validates birthday corrections" in test_text:
    raise SystemExit("birthday editor regression test already exists")
test_text += """

test('manual dossier editor validates birthday corrections through the canonical birthday engine',()=>{
  assert.match(source,/npc_state_delta_edit_birthday/);
  assert.match(source,/normalizeBirthDate\\(birthdayInput\\)/);
  assert.match(source,/applyNpcBirthdayUpdate\\(next,/);
  assert.match(source,/birthDateState: 'correct'/);
  assert.match(source,/Manual dossier birthday correction\\./);
  assert.match(source,/correctedBirthday\\.birthDateSourceMessageId = null/);
  assert.match(source,/set\\('npc_state_delta_edit_birthday', npc\\.birthDateDisplay \\|\\| ''\\)/);
});
"""
tests.write_text(test_text, encoding="utf-8")

contract = Path("docs/core-contract.md")
contract_text = contract.read_text(encoding="utf-8")
contract_text = replace_once(
    contract_text,
    "Grounded story facts may establish/correct dates; exact actual age and a compatible full owned date may derive a provisional birth year.",
    "Grounded story facts and explicit manual Edit Dossier corrections may establish/correct dates. Manual birthday corrections are validated against the active calendar and use the same canonical birthday continuity engine without a model call; exact actual age and a compatible full owned date may derive a provisional birth year.",
    "contract",
)
contract.write_text(contract_text, encoding="utf-8")

birthday_doc = Path("docs/birthday-continuity.md")
birthday_text = birthday_doc.read_text(encoding="utf-8")
birthday_text = replace_once(
    birthday_text,
    "Dossier birthday/form display is now part of the ordinary read-only projection; it does not require a document-wide observer or full-history copying.",
    "Dossier birthday/form display remains part of the ordinary read-only projection. Edit Dossier additionally exposes the canonical birthday as a validated manual correction field: changing it uses the same birthday continuity policy, marks the accepted date established, clears story-message provenance for the manual correction, recalculates deterministic calendar metadata where possible, and performs no model request. Invalid dates for the active calendar are rejected before canonical mutation. The projection still does not require a document-wide observer or full-history copying.",
    "birthday docs",
)
birthday_doc.write_text(birthday_text, encoding="utf-8")

changelog = Path("CHANGELOG.md")
change_text = changelog.read_text(encoding="utf-8")
marker = "# NPC State Delta changes\n\n\n"
entry = "# NPC State Delta changes\n\n\n## Unreleased\n\n- Add a Birthday field to Edit Dossier so generated or story-established dates can be corrected manually without editing extension JSON.\n- Validate manual birthday changes against the active calendar and route accepted corrections through the canonical birthday continuity engine without an extra model request; manual corrections clear story-message provenance.\n\n"
change_text = replace_once(change_text, marker, entry, "changelog")
changelog.write_text(change_text, encoding="utf-8")
