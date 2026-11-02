# Recovery enrollment before task admission

The Personal v1 Bridge relay now reserves a receipt containing both the task-file
hash and the exact submitted-message hash. The server validates that receipt
against the authenticated source message, room owner, target agent and pinned
task contract before changing its queue entry from `queued` to `running`.

For the existing `profile-personal-<request-id>` namespace, admission requires an
operator-owned `committed-result-recovery/admission.json` under `config.appHome`:

```json
{
  "version": 1,
  "profile": "personal",
  "ownerAuthUserId": 1,
  "roomId": "the-original-room",
  "targetAgentId": "the-codex-worker",
  "workspace": "/absolute/original/workspace",
  "receiptRoot": "/absolute/profile-bridge-requests/personal"
}
```

The policy permits this exact owner, room, workspace, worker and receipt directory;
it is not a per-task registration. Keep it outside agent task workspaces. This is
cooperative same-user trust, not filesystem confinement. Ordinary chat and other
profile namespaces keep their prior admission behavior; recovery support for
other profiles remains unverified.

Each task still needs its prepared v1 contract, task, checker and helper in
`workspace/profile-tasks/personal/<request-id>`. Admission validates their hashes
and refuses any prior invocation, claim, sample, result or commit. Registration
uses exclusive creation, a file flush and directory flushes before admission.
It carries `admission: bridge-admission-v1` and `enrolledAt` for proof. A matching
durable registration left before the database transition can be reconciled only
for the exact queued identity with no prior execution. Partial or conflicting
registrations are preserved and block admission.

Enrollment runs inside the queue's immediate transaction before context preparation
or worker invocation. Failure records `Recovery enrollment failed; worker not
started`, leaves `startedAt` empty and returns false to the invocation gate. No
retry, alternate executor, approval bypass or task cleanup is performed. The
paired relay reports `ADMISSION_BLOCKED` / `ENROLLMENT_FAILED`, exit 2, rather
than presenting a worker failure for a worker that never started.

After admission, existing restart recovery remains unchanged: verified committed
output is returned once; missing committed output remains unknown. A durable
registration is not proof that execution, result persistence or delivery happened.
The existing recovery source/queue/owner/hash checks still apply.

Deployment pairs the server, message-hashing relay and exact operator policy.
Prepare an immutable runtime and preserved relay before-image, then activate only
within the owner-authorized pilot scope and fresh idle/approval checks. Rollback
restores the prior runtime and relay and preserves any new registrations or claims;
never clear them to cause a retry. Removing the admission policy blocks new
Personal v1 admissions rather than silently admitting unenrolled work.

Acceptance includes enrollment failure with zero context/worker calls, normal
completion, durable registration before start, both saved/missing-result restart
cases and repeated reads without duplicate dispatch. Fixture proof and installed
live proof are separate gates.
