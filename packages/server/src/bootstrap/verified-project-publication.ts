import type { Readable, Writable } from 'node:stream'
import { AgentClients, type AgentConfig, type MentionMessage } from '../modules/studio/services/group-chat/agent-clients'
import { ProjectInvocationError } from '../modules/studio/services/group-chat/project-invocation'
import { VerifiedProjectPublication, type PublicationHooks, type ProjectPublisher } from '../modules/studio/services/group-chat/verified-project-publication'

/** Opt-in host composition only. No production import, socket or live launcher. */
export function createVerifiedProjectAgentClients(transport: { readable: Readable; writable: Writable }, hooks: PublicationHooks, publisher: ProjectPublisher) {
    const adapter = new VerifiedProjectPublication(transport, hooks, publisher)
    const clients = new AgentClients(adapter), registered = new Set<string>()
    // The raw manager is deliberately private: arbitrary executors and its
    // legacy createAgent socket path cannot bypass the captured output sink.
    return Object.freeze({
        registerAgent(roomId: string, config: AgentConfig) {
            if (!roomId || !config.agentId || registered.has(JSON.stringify([roomId, config.agentId]))) throw new ProjectInvocationError('CAPTURED_AGENT_REGISTRATION_REQUIRED', false)
            const client = adapter.createCapturedAgent(config)
            clients.registerAgentForRoom(roomId, client)
            registered.add(JSON.stringify([roomId, config.agentId]))
            return client
        },
        setStorage: clients.setStorage.bind(clients),
        processMentions(roomId: string, msg: MentionMessage) {
            if (msg.continuationAttemptId) throw new ProjectInvocationError('QUALIFIED_CONTINUATION_PUBLICATION_REQUIRED', false)
            return clients.processMentions(roomId, msg)
        },
        close: adapter.close.bind(adapter),
    })
}
