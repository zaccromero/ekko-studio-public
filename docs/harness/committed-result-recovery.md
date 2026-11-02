# Committed result recovery

The group-chat server scans `config.appHome/committed-result-recovery/registrations/*.json` once at startup, after existing interrupted-queue reconciliation. This is opt-in operator enrollment for Personal readiness tasks using the v1 `contract.json`, `started.json`, `commit.json`, `sample.json`, `result.json` artifact protocol. It does not enroll arbitrary tasks or resume unfinished computation.

An operator enrolls a task before interruption by writing one registration outside the task workspace:

```json
{
  "version": 1,
  "profile": "personal",
  "requestId": "personal-task-01",
  "roomId": "room-id",
  "ownerAuthUserId": 1,
  "messageId": "original-message-id",
  "queueId": "original-queue-id",
  "targetAgentId": "existing-worker-id",
  "workspace": "/absolute/original/room/workspace",
  "contractSha256": "64-lowercase-hex-digest-of-contract-json"
}
```

Enrollment is a trusted local operator action, not a chat command or public API. The source message must belong to that room owner; the queue must match its message, worker and requester. Cancelled, queued, unknown and current-boot work is not recovered. The original worker must still belong to the room. A normal request-tagged return suppresses recovery.

The service reads only fixed artifacts below the pinned room workspace (`profile-tasks/personal/<requestId>`), rejects symlinks/non-regular/oversized files, checks the contract and task/checker/helper hashes, and checks commit/result/sample hashes and execution identity. It never imports task code, invokes a model, calls a network service or changes a queue. Hashes prove integrity relative to the committed artifacts, not semantic accuracy or authenticity against a malicious worker with access to all artifacts. The recovery message explicitly labels saved historical output and this limit.

A deterministic room/request message ID is published under a SQLite immediate transaction. An existing matching message is the delivery receipt; a collision is refused. A crash before commit rolls back; a crash after commit leaves the result in room history even if live notification was interrupted. There is one durable result message, not an exactly-once guarantee for network notifications or arbitrary external effects. Original queue status and worker errors are retained. Unknown/missing/corrupt artifacts do not clear execution claims or cause a retry.

Registrations are capped at 100 per startup; missing enrollment is a no-op. Recovery outcomes appear in structured server logs as `RECOVERED_SAVED_RESULT`, `ALREADY_RETURNED`, `NORMAL_RETURN_PRESENT`, or `UNKNOWN_DO_NOT_RETRY`, without artifact contents. Preserve registrations and artifacts during investigation. To disable this capability, roll back to the previous immutable server release or move the operator registration out of the scanned directory while the service is stopped. Do not delete execution claims.

Validation: `tests/server/committed-result-recovery.test.ts` covers file/binding/failure boundaries; `committed-result-recovery-startup.test.ts` exercises the actual server constructor and persistence with interrupted work across two startup reconciliations. Live acceptance requires one real committed task, one service restart, automatic room-history return and unchanged workload execution evidence. Local tests alone do not establish that outcome.


## Publication ownership for new enrolled tasks

New Personal enrollment creates a durable `gc_publication_authority` row and pins
its `{queueId, epoch}` lease in the registration before invocation. The current
worker may publish only while that generation still owns publication. Invocation
context stays in server-owned async state; message and stream bindings are issued
by the local client, not supplied in a model prompt. Durable message writes check
the lease again inside their save transaction, including delayed socket delivery.
Ordinary chat and retained historical registrations keep their previous behavior.
This is cooperative same-user control, not confinement against direct database or
filesystem tampering, nor a transfer of external Kanban claims.

An authenticated, joined room owner may emit `transfer_task_publication` with
`roomId`, `queueId`, and `expectedEpoch`. The handler checks the authenticated
account against the original owner again inside an immediate transaction. The
compare-and-swap changes publication ownership from worker to recovery and advances
the epoch once. It does not dispatch, requeue, cancel or rerun execution. Duplicate,
stale, foreign-room and foreign-owner requests fail closed. An automated request
under an account is not evidence of a fresh human approval; callers still require
actual owner authority for the operation.

The transfer freezes the exact commit hash already present, or records absence.
Late/backdated files cannot replace an absent snapshot or change the frozen hash.
They stay on disk as evidence. Startup applies that same transfer to earlier
worker-owned tasks before recovery; later startups never take another snapshot.
Recovery validates the frozen hash, complete artifacts, original identities and
current recovery generation in its publication transaction. A valid earlier
result returns once; an unverified or stale result remains UNKNOWN_DO_NOT_RETRY.
Room/worker/queue/source ownership binding changes revoke authority irreversibly,
including changing away and back. Nothing resets an execution claim.

Rollback before the first new enrollment may restore the prior release. Once any
new fenced registration exists, an older publisher that ignores these leases is
not a compatible rollback, even if the original worker is terminal. Preserve the
new authority state and use a compatible forward repair; never delete leases or
registrations to make a downgrade possible. This gate is separate from build/CI,
owner merge approval, activation and real runtime acceptance.
