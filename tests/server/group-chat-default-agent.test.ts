import { describe, expect, it, vi } from 'vitest'
import { AgentClients } from '../../packages/server/src/modules/studio/services/group-chat/agent-clients'

function setup(defaultAgentId: string, connected = true) {
  const clients = new AgentClients()
  const agents = [
    { agentId: 'hermes', name: 'Hermes', connected: true },
    { agentId: 'codex', name: 'Codex', connected: true },
  ] as any[]
  vi.spyOn(clients, 'getConnectedAgents').mockReturnValue(connected ? agents : agents.slice(1))
  clients.setStorage({ getRoom: () => ({ defaultAgentId }) })
  const queue = vi.spyOn(clients as any, 'queueMention').mockReturnValue(Promise.resolve(null))
  vi.spyOn(clients as any, '_drainRoomQueues').mockResolvedValue(undefined)
  const message = (content: string, role = 'user') => clients.processMentions('room', {
    content, role, senderId: 'human', senderName: 'Human', timestamp: 1,
  })
  return { clients, queue, message }
}

describe('group chat default Agent', () => {
  it('routes an untagged human message to the configured connected Agent once', async () => {
    const h = setup('hermes')
    await expect(h.message('Please help')).resolves.toMatchObject({ targetCount: 1, deliveredCount: 1 })
    expect(h.queue).toHaveBeenCalledTimes(1)
    expect(h.queue.mock.calls[0][1].map((agent: any) => agent.agentId)).toEqual(['hermes'])
  })

  it('keeps explicit mentions and @all ahead of the default', async () => {
    const h = setup('hermes')
    await h.message('@Codex review this')
    expect(h.queue.mock.calls[0][1].map((agent: any) => agent.agentId)).toEqual(['codex'])
    await h.message('@all compare this')
    expect(h.queue.mock.calls[1][1].map((agent: any) => agent.agentId)).toEqual(['hermes', 'codex'])
  })

  it('does not silently route unknown mentions or Agent replies to the default', async () => {
    const h = setup('hermes')
    await h.message('@Unknown please help')
    await h.message('Agent reply', 'assistant')
    expect(h.queue.mock.calls[0][1]).toEqual([])
    expect(h.queue).toHaveBeenCalledTimes(1)
  })

  it('reports an unavailable default instead of choosing another Agent', async () => {
    const h = setup('hermes', false)
    await expect(h.message('Please help')).resolves.toMatchObject({
      targetCount: 1, deliveredCount: 0, errors: ['Default Agent is unavailable'],
    })
    expect(h.queue).not.toHaveBeenCalled()
  })
})
