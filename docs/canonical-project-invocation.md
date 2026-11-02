# Ekko to the canonical async invocation backend

This opt-in source connection joins Ekko PR #10 and the canonical Python async
backend merged in drako-claude-config PR #138 (`5d3ffac`). The routing lane owns
these six new files and the connection. Existing adapter, async coordinator,
permission/carrier/journal/backend, scanner and CI files and claims stay intact.

## Explicit host composition

`createCanonicalProjectAgentClients(transport, hooks)` composes the existing
protected AgentClients factory with `CanonicalProjectInvocationHost`. The
transport is an already-owned private readable/writable stream pair. Nothing
starts a child, opens a network listener, installs a setting or changes the
production singleton. Production bootstrap never imports this new factory.

The protected Python host imports `canonical_project_invocation.py` with the
canonical source directory already configured by trusted composition. It supplies
a context-manager factory for the exact canonical InvocationHost, fixed executor
identities and immutable route records. The module uses the real
`AsyncInvocationHost`, `PermissionStore`, carrier checks and `InvocationLedger`;
it contains no copied authority, parser, database schema or journal.

The host supplies two mandatory TypeScript hooks, never room/message fields:

- `effect(binding, target, approvedPayload, invoke)` verifies the actual prepared
  inputs and executor against the approved stored bytes, enforces consequential
  sub-effects, calls `invoke` exactly once, awaits its complete reply and returns
  bounded immutable internal-result bytes. The transport additionally drains a
  started callback if this hook returns or throws prematurely. Duplicate, missing
  or failed callbacks remain failures even if the hook swallows an exception.
- `verifyResult(binding, target, savedResult)` performs independent same-request
  result validation. It is not a human-approval token. It receives the canonical
  saved result only after the fence exit and durable completion acknowledgment.

The carrier parser is the actual host-loaded `project-carrier.mjs` `parseCarrier`.
No task/message JSON chooses a factory, module/source path, credentials, database,
executor function, route registration or verifier. A same-user private pipe is a
cooperative protected composition, not cryptographic client authentication or
filesystem confinement. Do not expose this channel as an agent tool, public HTTP
API or cross-host transport without separate qualification.

## Duplex lifetime and truthful outcomes

The Python channel registers only host-provided routes through canonical binding
checks. Resolve uses a fresh canonical recovery/read-authority gate, returning
only the protected carrier and association. Invoke rechecks the full target,
carrier and independently configured association against that record.

The canonical backend commits STARTED, enters the existing permission adapter
transaction/fence and then emits an `effect` frame containing the exact approved
payload. Ekko verifies the target/binding/payload digest before calling its fixed
host hook. The original PR10 coordinator extends this callback through the entire
reply, rather than only the Hermes launch/run-ID acknowledgment.

After the callback and hook settle, Ekko sends bounded result bytes or a failed
settlement. Python's canonical backend exits the **same** fence and commits the
result before returning the completion acknowledgment. Ekko validates that result
digest, then `acceptResult` performs a freshly authorized canonical recovery read
and independent result validation. A missing/early/wrong/failed acknowledgment
never becomes successful queue delivery. Results and payloads are limited to
1 MiB; frames to 2 MiB; pending calls to 64; request identities to 2048 per channel.

`recoverResult` is a separate explicit protected read and independent validation
of the same canonical saved result. It never invokes an executor, reconnects,
resubmits a draft, renews permission or starts a replacement job. Failed or unknown
invocations remain non-retryable under the canonical journal.

## Lost transport and shutdown

EOF, malformed frames or a write failure poison the TypeScript channel. Already
started callbacks are drained locally before their caller rejects. The transport
never kills a child, restarts a service or automatically retries.

A lost pipe is **not** remote quiescence. If Python emitted an effect without a
settlement, it retains the pending canonical callback/fence. A separately supplied
protected `drain_on_disconnect(target)` hook may release that hold only after it
positively establishes actual executor and consequential-sub-effect quiescence.
Missing, failed or boolean-returning proof keeps the hold. The hook is fixed at
host composition, never supplied by a message. No hook means the fence remains
held until separately authorized control-plane recovery intervenes. Source tests
stop only their own synthetic process after their synthetic callback has drained.

Graceful `close` rejects new work, drains existing requests, closes the canonical
backend on its owner thread and acknowledges shutdown. Keep the owning event loop
and physical host alive through settlement/close. Process death, lost model runtime
or host power loss still require external recovery, retaining STARTED/UNKNOWN;
this in-process connection cannot certify a surviving external effect.

## Validation and remaining required acceptance

The real connection tests launch a synthetic private Python fixture and use the
actual canonical modules, parser, temporary durable SQLite stores, existing async
adapter and actual Group Chat queue. Only authority observations, executor effects
and result verifier are synthetic. Tests prove the source connection; they are
not real human-provenance, external-fence, model, native or cloud certification.

Required local affected check (the canonical source dependency must be supplied):

```sh
CANONICAL_PROJECT_SOURCE=/absolute/approved/drako-claude-config npm run test -- tests/server/canonical-project-invocation.test.ts
```

The source path is test/host configuration, never message data. Clear inherited
HERMES/EKKO/ELECTRON/AUTH_TOKEN/PORT from the test process only, use regular Node
and Python, and leave live runtime environments unchanged. Record the actual
canonical source revision and hashes in the task receipt. Unchanged PR7/PR10 and
PR138 tests/reviews remain retained rather than manually rerun.

Run `npm run harness:check` and `npm run build` per the change-type gate. Broad
coverage and browser suites run once through existing hosted PR workflows. CI
without the separately supplied canonical repository explicitly skips the real
cross-repository cases and runs the protocol-negative cases; that CI pass is NOT
real-connection proof. The local real-connection result is mandatory and separate.
There are no new hosted credentials, network downloads or private-source copies.
The explicit Python module is source-hosted; no packaged production launcher or
runtime activation is installed by this change.

Actual host input/executor enforcement, human provenance, independent validation
BEFORE streamed publication, the verified publisher, cloud authority/history,
Mac-off recovery, independent native checks and eight project journeys remain
OPEN_REQUIRED. Existing reply code may stream before `acceptResult`; this source
connection must not be presented as pre-publication certification. Installation,
merge, deployment and runtime changes require their existing separate authority.

## Candidate proof

Base `7d2a49a90bd0f2165787fbe6d41f17cdb5569ef4` plus exactly six new files. All 19 new connection tests
PASS with the actual canonical modules matching PR138 merge `5d3ffac`; the
canonical Ekko harness and production build PASS. One final scoped P0/P1 review
closed with P0=0/P1=0. Existing PR7/PR10/PR138 component proofs remain retained.
Hosted broad workflows are observed once after publication; a hosted skip of the
external canonical dependency is not local connection proof. No runtime activated.
