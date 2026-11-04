import { expect, it, vi } from 'vitest'
import { AgentClient, AgentClients } from '../../packages/server/src/modules/studio/services/group-chat/agent-clients'

it('does not advertise the protected project effect boundary for a hosted VM agent', () => {
  const agent = new AgentClient({ agentId: 'hermes_123', agent: 'hermes', profile: 'default',
    name: 'Hermes', description: '', invited: Date.now(), backgroundDelegationEnabled: false })
  expect(agent.projectInvocationBoundary).toBe(true)
  agent.setHostedRoomConfig({ roomId: 'room_123', agentId: 'hermes_123', bootstrapUrl: 'https://hermes.example/',
    credential: () => 'test-only', identity: { room_id: 'room_123', home_install_id: 'home_123',
      authority_gateway_id: 'gateway_123', authority_epoch: 1, member_id: 'hermes_123' },
    target: { installId: 'target_123', profile: 'default', origin: 'https://hermes.example' } })
  expect(agent.projectInvocationBoundary).toBeUndefined()
  expect(agent.requiresDurableQueue).toBe(true)
})

it('enrolls peer turns only for an executor that requires a durable remote task', async () => {
  const clients = new AgentClients()
  const enqueue = vi.fn().mockReturnValue({ id: 'queue_123' })
  const fail = vi.fn()
  clients.setStorage({ enqueueExecutionQueueItem: enqueue, failExecutionQueueItem: fail })
  const hosted = {
    agentId: 'hermes_123', name: 'Hermes', requiresDurableQueue: true as const,
    reserveInvocation: vi.fn(), releaseInvocation: vi.fn(),
  }
  const peer = {
    messageId: 'message_123', content: '@Hermes, review this plan', senderName: 'Claude',
    senderId: 'claude_123', timestamp: Date.now(), role: 'assistant',
  }
  const hostedPending = (clients as any).queueMention('room_123', [hosted], peer)
  expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
    roomId: 'room_123', messageId: 'message_123', targetAgentId: 'hermes_123',
    requesterMemberId: 'claude_123',
  }))
  ;(clients as any).clearMentionQueuesForRoom('room_123')
  await hostedPending
  expect(fail).toHaveBeenCalledWith('queue_123', 'Room execution queue was cleared')

  enqueue.mockClear()
  const localPending = (clients as any).queueMention('room_123', [{ ...hosted, requiresDurableQueue: undefined }], peer)
  expect(enqueue).not.toHaveBeenCalled()
  ;(clients as any).clearMentionQueuesForRoom('room_123')
  await localPending
})
