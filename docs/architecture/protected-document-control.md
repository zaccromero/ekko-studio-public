# Protected document control client

This opt-in source interface connects a protected Studio host to the fixed
Python `DocumentControlChannel` from drako-claude-config PR #171. It directly
controls the existing native-owned document flow rather than requesting a remote
AgentClient callback. Importing or constructing it does not submit a task.

Only protected composition may call
`createProtectedDocumentControlClient(transport, target, binding)`. Production
bootstrap remains unchanged. The host must independently obtain the actual full
room/message/agent/queue target, canonical carrier and association, and exclusive
private pipe ownership. No HTTP/Socket.IO route, public agent tool, model prompt,
payload, credential, approval flag or fallback execution path is added here.

`transport.drained()` is a host-owned teardown proof: it must wait for this
connection's actual Python control/factory to finish. A disconnected socket or
agent-provided promise does not qualify that proof. The real host port and task
association still need separate integration and qualification before activation.

## Explicit operations

- `executePrivately(signal?)` returns a digest marked `PRIVATE_CAPTURED` and
  `verified:false`. It does not publish or independently verify model output.
- `publishDocument(digest, signal?)` requests the separate, freshly authorized
  Python publisher and accepts only a matching local-document receipt. It does
  not publish to a room or GitHub, merge, install or deploy.
- `recover(digest?, signal?)` requests saved recovery. Without a supplied digest,
  the Python host uses its protected metadata hint. It never executes or publishes
  as a fallback; uncertain results remain `UNKNOWN` and `replayed:false`.
- `close()` stops new admissions, ends input and waits for the protected host's
  actual teardown. A lost response remains uncertain, not successful cancellation.

The Python endpoint still rechecks current human permission, source/instructions,
owner, executor credentials and saved evidence. Metadata identity is not authority.
Account authentication and a successful source test do not establish human approval.

## Failure behavior

The client snapshots the fixed binding/route. It admits at most eight pending
requests and 1,024 correlation IDs per connection. Responses must be bounded,
canonical UTF-8 JSON with exact fields. It accepts whitelisted digests and
local-document receipt metadata only; extra private bytes or approval fields,
wrong digests/scopes, malformed frames and unexpected IDs fail closed.

An AbortSignal sends a cancellation frame for the same request and awaits the
original response/host teardown. It never detaches or repeats work. Stream loss
poisons pending requests as unknown, rejects new ones, and never restarts a worker,
resubmits a task, releases a claim or invokes a generic AgentClient. Reconnection
requires separately constructed protected ports and explicit saved recovery.

## Source verification

Run the repository's focused Vitest file:

```sh
npm run test -- tests/server/protected-document-control-client.test.ts
```

The protocol cases need no account, model, credential, live ownership board or
external service. Real Node/Python pipe integration additionally requires the
explicit private canonical source dependency:

```sh
CANONICAL_PROJECT_SOURCE=/absolute/reviewed/drako-claude-config \
CANONICAL_TEST_PYTHON=/absolute/development/python3 \
npm run test -- tests/server/protected-document-control-client.test.ts
```

That source must contain `project_document_channel.py`, its existing canonical
dependencies and contract fixture. The test uses real temporary Git/SQLite/files
and OS pipes, with explicitly **synthetic** human, owner, authority and model.
The child exits successfully only after its actual control/factory drains. Hosted
CI without the private source reports this one integration case skipped; it is
not mirrored hosted proof. Local connection acceptance must supply the dependency
and run it, never count the skip as a pass.

Follow `docs/harness/validation.md` for the repository gate. Live task routing,
real human/provider/model qualification, shared/Git publication, source merge,
installation/deployment, cloud history and Mac-off acceptance remain separate
required outcomes. This source interface does not complete those outcomes.
