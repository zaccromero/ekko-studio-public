import { AgentClients } from '../modules/studio/services/group-chat/agent-clients'
import { AsyncProjectInvocationAdapter } from '../modules/studio/services/group-chat/async-project-invocation'
import type { ProjectInvocationHost } from '../modules/studio/services/group-chat/project-invocation'

/** Explicit host composition only. Production bootstrap never calls this factory. */
export function createProtectedProjectAgentClients(service: ProjectInvocationHost): AgentClients {
    return new AgentClients(new AsyncProjectInvocationAdapter(service))
}
