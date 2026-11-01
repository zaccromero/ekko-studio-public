# Source-only project invocation adapter

`AgentClients` accepts an optional `ProjectInvocationAdapter` constructor port.
Its existing singleton is unchanged and supplies no port: this PR installs no
runtime host, enables no project binding and accepts no new Socket.IO fields.
The strict native selector v1 is unchanged. The default flow remains unbound.

For host composition, the adapter runs at the last Group Chat dispatch boundary,
after room-summary preparation and queue admission, carrying an async-local
protected association through `replyToMention`. The fresh guard runs immediately
at `bridge.chat` or `runAndWait`, after capabilities/model/input preparation.
Executors without these final-launch hooks reject bound dispatch before starting. It does not turn queue admission or recovery enrollment into
permission. A protected host resolves an association using room/message/agent/
queue identity, independently of message content and worker assertions. The
carrier remains the separate three-field v1 sidecar merged in
[zaccromero/drako-claude-config#128](https://github.com/zaccromero/drako-claude-config/pull/128).
The host supplies that source's canonical `parseCarrier`; this repository does
not fork its parser or hash arbitrary binding JSON.

`ProjectInvocationHost.runEffect` must perform fresh canonical authority checks
and invoke the supplied callback inside the actual service fence. It must check
human provenance, all four Association fields, binding digest, source/executor,
current ownership/epoch and durable invocation deduplication. It must await the
callback and return only after its completion. The async-local scope is isolated per invocation, retained failures cannot be
swallowed by existing reply error handlers, and no association is placed in a
room post or native selector. The adapter closes the callback
on guard exit, rejects zero or repeated invocations, and waits for any invocation
already started even when a faulty host returns early. There is no reusable
allow boolean and no detached subprocess preflight. These callback checks are
local protocol checks, not a substitute for an atomic service fence or ledger.

`acceptResult` independently validates the same-request result and declared
regular-file evidence. A returned worker response grants no new authority.
Any failure after invocation begins carries `outcomeUnknown: true`; the queue
surfaces failure without automatically retrying or reporting delivery. This hook
runs after `replyToMention` returns: that method may already stream output, so it
is **not a pre-publication gate**, nor proof that its downstream effects were
fenced. General bound operation must stay NOT_ENABLED until those lower service
and publication boundaries have real enforcement and acceptance evidence.

The host's `resolve` may return `null` only when its protected routing says the
request belongs to the pre-existing unbound flow. Missing or unqualified bound
support must throw (for example `NOT_ENABLED`), never return `null` as an error
fallback. No production bootstrap installs this adapter yet. A future installer
must reject bound requests when no qualified host is present; it must not simply
attach agent-supplied sidecars to the legacy route.

Source tests cover the actual queue caller, late revocation after context
preparation, synchronous invocation, association/carrier preservation, denied,
missing/delayed/repeated callbacks, result rejection, and unknown outcomes.
They run with fake executors and hosts only. Service-level fencing, durable
ledger/provenance, Zeus overlay integration, native/cloud qualification,
post-merge installation and the eight-project owner journey remain NOT_RUN.
This PR changes no live configuration, profiles, credentials or services.
