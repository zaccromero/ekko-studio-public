# Verified noninteractive project publication

This opt-in source composition builds on Ekko PR12 (`c8dac24a`). The original
connection verifies results after the existing reply handler has streamed them.
`createVerifiedProjectAgentClients` instead registers actual `AgentClient`
instances with a private capturing event sink. It does not import itself into
production, open a socket, launch a model, install configuration or change a
running service. Existing factories and claimed files remain unchanged.

The protected host supplies the existing canonical parser, private streams,
input/executor/sub-effect enforcement, independent result verifier and a separate
publisher. Rooms, messages and executor output cannot configure those ports.

## Ordering and authority

1. The actual Group Chat queue invokes the existing async adapter and canonical
   Python host. Its original permission fence covers the complete reply.
2. Actual `AgentClient.sendMessage` and stream events go into bounded private
   staging. Their returned IDs acknowledge capture, **not persistence or delivery**.
   Workspace-diff finalization uses a staged storage facade: its draft is included
   in the manifest without calling the live `gc_messages` writer or broadcaster.
   The facade preserves existing room/member reads and identity metadata methods;
   it does not expose arbitrary live content writers.
3. After the complete callback settles, the exact output manifest (binding, full
   target and ordered message/event data) becomes the canonical saved result.
4. The original fresh recovery authorization and independent verification run
   after canonical fence exit. Saved bytes must exactly match the staged manifest.
5. Only then is the fixed protected publisher called once, with immutable manifest
   text and binding/target snapshots. Queue completion awaits a matching publication
   receipt: target, SHA256, publication ID and `PUBLISHED` status.

The publisher port MUST reauthorize publication and hold its own durable fence
across the actual external effects for the same request, execution and target.
Execution authorization is not publishing authorization. A preflight followed by
an unfenced write is insufficient. This PR supplies the ordering/receipt boundary;
it does **not** claim an injected publisher has been qualified by being configured.
Git branches/PR publication, human provenance and the real external publisher still
require their separately owned implementations and acceptance proof.

The composition exposes registration of its own captured AgentClients and the
existing queue entry point. It does not expose the raw manager, arbitrary executor
registration or the legacy socket factory. It is a cooperative protected host
composition, not isolation against hostile same-process JavaScript.

## Failure and recovery

- Maximum manifest size: 1 MiB; maximum captured events: 2048; bounded JSON depth,
  nodes, active targets and lifetime request identities. Payloads are copied at
  capture; accessors, executable values, unsupported objects and unknown events fail
  closed. Swallowed capture errors remain terminal for the invocation.
- Targets must match the captured agent and room. Concurrent full targets retain
  separate manifests. Closed/sealed contexts reject late output.
  Canonical transport callbacks explicitly restore the matched target's capture
  context before creating executor/streaming async resources. A workspace finalizer
  outside that context rejects and latches active captured invocations rather than
  silently dropping an unverified diff while reporting success.
- Approval, clarification and continuation delivery require a separately qualified
  human-control path. This noninteractive composition rejects them. It never silently
  buffers a human prompt or submits an approval. Actual executor cancellation and
  quiescence remain protected host responsibilities, as in PR12.
- Before publisher invocation, failure publishes nothing. Publisher failure,
  partial effects or a lost/mismatching receipt remain UNKNOWN. There is no automatic
  retry/replay, per-event fallback, reconnect, channel restart or claim release.
- Captured output is bounded in-memory staging. It is not shared history, an
  offline draft queue or crash recovery. The canonical saved result can survive;
  recovery must use separately authorized verification/publication and truthful
  outcome reconciliation. Composition lifetime identity reuse is rejected.
- The host must keep the process and canonical channel alive until callbacks drain.
  `close` rejects new work, waits for both invocation and publisher tails, then
  closes the channel. Cancellation during publication drains and returns UNKNOWN;
  it never detaches an effect or replays a manifest.
  Process/host death cannot certify external quiescence or publication outcome.

## Verification

Run the new focused suite with the actual canonical dependency supplied:

```sh
CANONICAL_PROJECT_SOURCE=/absolute/approved/drako-claude-config npm run test -- tests/server/verified-project-publication.test.ts
```

Protocol tests use a synthetic channel for concurrency and rejection cases. The
separate real-process journey uses the actual canonical modules, parser, durable
temporary SQLite stores, actual AgentClient capture and actual Group Chat queue.
Authority observations, executor and publisher are synthetic: this is source
integration evidence, not human/model/cloud/native/live publication certification.
Without the canonical repository CI explicitly skips that journey; it is not a PASS.

Run the canonical harness and production build for this source change. Existing
PR7/10/12 component proofs and closed reviews are retained. Broad hosted workflows
run automatically for this PR; do not manually rerun passing checks or duplicate jobs.

Full parent outcome remains OPEN_REQUIRED: real protected input/human/sub-effect
and publisher qualification, stable parent/latest authorized continuation mapping,
interactive human flow, cloud authority/history migration, Mac-off recovery,
independent native checks and eight-project journeys. Installation, merge and
deployment retain their own explicit authority. No runtime is activated here.
