# NSD fix, correction round 2

## Why the reload test failed
`tests/stale-chat-host-reload.test.js` reloads a chat whose stored lineage (4) is longer than the host's loaded chat (2). The correction made that
automatic tail-truncation rollback wait for `hostChatComplete`, which requires a readable host chat file. That test host answers `/api/chats/get`
with HTTP 404 (no file), so the check never passed. The reconcile deferred until its retries ran out and the lineage never became the reloaded chat.

## Fix (code only; test unchanged)
- runtime-branch.js `hostChatComplete(key, { absentOk })`: with `absentOk`, an HTTP 404 (the host has no file for this chat, so it cannot disagree with
  the array it loaded) counts as complete, but only if the loaded chat is non-empty. A timeout, a malformed file, a non-404 error or a file that
  disagrees still fail closed.
- runtime-reconcile.js: the automatic rollback passes `absentOk: true`. An EMPTY chat with a non-empty stored lineage is still deferred, so the original
  bug stays closed. Inheritance and participant hydration still require a real matching file (no `absentOk`).
- New-chat limitation: the bounded retry now has a slow phase (5 s x 12 after the 25 fast tries of 400 ms). `MESSAGE_RECEIVED` also queues a reconcile
  when branch inheritance is pending (the host saves the chat around a reply), so a new chat hydrates once its file appears.

## Tests
- tests/reload-empty-chat-reconcile.test.js: a brand-new chat with no host file stays pending and writes nothing, then hydrates after the file appears
  and a reply is received.
- tests/stale-chat-host-reload.test.js passes unmodified.

## Results
- `npm test`: 1902 tests, 1902 pass, 0 fail, exit 0. `npm run validate` passed. `git diff --check origin/main` clean. size-codemap-check: see run output
  (modified files all under 450 lines: 176 / 371 / 271).
- Not done: no live-host check; whether real SillyTavern answers a missing chat file with 404 or `{}` is not verified (`{}` stays fail-closed).
