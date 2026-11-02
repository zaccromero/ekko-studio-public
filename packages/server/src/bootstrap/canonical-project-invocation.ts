import type { Readable, Writable } from 'node:stream'
import { CanonicalProjectInvocationHost, type CanonicalInvocationHooks } from '../modules/studio/services/group-chat/canonical-project-invocation'
import { createProtectedProjectAgentClients } from './project-invocation'

/** Explicit protected composition only. Production bootstrap never calls this. */
export function createCanonicalProjectAgentClients(transport: { readable: Readable; writable: Writable }, hooks: CanonicalInvocationHooks) {
    const service = new CanonicalProjectInvocationHost(transport, hooks)
    return { clients: createProtectedProjectAgentClients(service), service }
}
