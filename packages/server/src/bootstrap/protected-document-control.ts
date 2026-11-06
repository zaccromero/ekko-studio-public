import { ProtectedDocumentControlClient } from '../modules/studio/services/group-chat/protected-document-control-client'
import type { BoundProjectInvocation, ProjectInvocationTarget } from '../modules/studio/services/group-chat/project-invocation'
import type { Readable, Writable } from 'node:stream'

/** Explicit protected composition only; production bootstrap does not call it.
 * drained must observe this connection's actual control/factory teardown.
 * A room packet, socket close, or arbitrary agent promise is not that proof.
 */
export function createProtectedDocumentControlClient(
    transport: { readable: Readable; writable: Writable; drained(): Promise<void> },
    target: ProjectInvocationTarget,
    binding: BoundProjectInvocation,
): ProtectedDocumentControlClient {
    return new ProtectedDocumentControlClient(transport, target, binding)
}
