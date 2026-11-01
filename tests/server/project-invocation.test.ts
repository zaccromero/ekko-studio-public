import { describe, expect, it, vi } from 'vitest'
import {
  ProjectInvocationAdapter,
  runProjectInvocationEffect,
  type ProjectCarrier,
  type ProjectInvocationHost,
} from '../../packages/server/src/modules/studio/services/group-chat/project-invocation'
import { AgentClients, AgentClient } from '../../packages/server/src/modules/studio/services/group-chat/agent-clients'

const target = { roomId: 'room-1', messageId: 'message-1', agentId: 'agent-1', queueId: 'queue-1' }
const carrier: ProjectCarrier = { version: 1, binding_ref: 'protected-ref', binding_digest: 'a'.repeat(64) }
const association = { project: 'project-1', request_id: 'request-1', execution_id: 'execution-1', payload_digest: 'b'.repeat(64) }
function host(overrides: Partial<ProjectInvocationHost> = {}): ProjectInvocationHost {
  return {
    resolve: vi.fn(async () => ({ carrier, association })),
    // The real parser is injected by host composition; no fork of canonical authority.
    parseCarrier: vi.fn(raw => raw as ProjectCarrier),
    runEffect: vi.fn(async (_binding, _target, invoke) => { await invoke() }),
    acceptResult: vi.fn(async () => {}),
    ...overrides,
  }
}

function adapter(h: ProjectInvocationHost) {
  const a = new ProjectInvocationAdapter(h)
  return { run: (t: typeof target, effect: () => Promise<void>) => a.run(t, () => runProjectInvocationEffect(target, effect), true) }
}

describe('source-only project invocation adapter', () => {
  it('preserves the independent host association/digest and invokes synchronously inside the fence', async () => {
    const order: string[] = []
    const h = host({ runEffect: async (binding, context, invoke) => {
      expect(binding).toEqual({ carrier, association })
      expect(context).toEqual(target)
      expect(Object.isFrozen(binding.association)).toBe(true)
      expect(Object.isFrozen(binding.carrier)).toBe(true)
      order.push('fence')
      const result = invoke()
      expect(order).toEqual(['fence', 'effect'])
      await result
      order.push('fence-exit')
    }, acceptResult: async () => { order.push('result') } })
    await adapter(h).run(target, async () => { order.push('effect') })
    expect(h.parseCarrier).toHaveBeenCalledWith(carrier)
    expect(order).toEqual(['fence', 'effect', 'fence-exit', 'result'])
  })

  it('retains explicit protected unbound routing without calling bound ports', async () => {
    const h = host({ resolve: async () => null })
    const effect = vi.fn(async () => {})
    await adapter(h).run(target, effect)
    expect(effect).toHaveBeenCalledOnce()
    expect(h.runEffect).not.toHaveBeenCalled()
    expect(h.acceptResult).not.toHaveBeenCalled()
  })

  it.each(['NOT_ENABLED', 'ASSOCIATION_MISMATCH', 'REVOKED', 'STALE_EPOCH'])('fails closed on host %s without invoking', async code => {
    const h = host({ runEffect: async () => { throw new Error(code) } })
    const effect = vi.fn(async () => {})
    await expect(adapter(h).run(target, effect)).rejects.toMatchObject({ outcomeUnknown: false, cause: { message: code } })
    expect(effect).not.toHaveBeenCalled()
    expect(h.acceptResult).not.toHaveBeenCalled()
  })

  it('does not fall back when protected lookup is unavailable', async () => {
    const h = host({ resolve: async () => { throw new Error('NOT_ENABLED') } })
    const effect = vi.fn(async () => {})
    await expect(adapter(h).run(target, effect)).rejects.toThrow('NOT_ENABLED')
    expect(effect).not.toHaveBeenCalled()
  })

  it('does not invoke after canonical carrier parsing fails', async () => {
    const h = host({ parseCarrier: () => { throw new Error('INVALID_CARRIER_FIELDS') } })
    const effect = vi.fn(async () => {})
    await expect(adapter(h).run(target, effect)).rejects.toThrow('INVALID_CARRIER_FIELDS')
    expect(effect).not.toHaveBeenCalled()
    expect(h.runEffect).not.toHaveBeenCalled()
  })

  it.each([false, true])('closes a delayed callback after guard exit (denied=%s)', async denied => {
    let delayed!: () => Promise<void>
    const h = host({ runEffect: async (_b, _t, invoke) => {
      delayed = invoke
      if (denied) throw new Error('DENIED')
    } })
    const effect = vi.fn(async () => {})
    await expect(adapter(h).run(target, effect)).rejects.toMatchObject({ outcomeUnknown: false })
    expect(() => delayed()).toThrow('INVOCATION_CALLBACK_CLOSED')
    expect(effect).not.toHaveBeenCalled()
  })

  it('rejects repeated callbacks even if the host swallows the second rejection', async () => {
    const h = host({ runEffect: async (_b, _t, invoke) => {
      await invoke()
      try { await invoke() } catch { /* faulty host */ }
    } })
    const effect = vi.fn(async () => {})
    await expect(adapter(h).run(target, effect)).rejects.toMatchObject({ outcomeUnknown: true })
    expect(effect).toHaveBeenCalledOnce()
    expect(h.acceptResult).not.toHaveBeenCalled()
  })

  it('awaits a started effect but rejects the protocol when the host returns early', async () => {
    let finish!: () => void
    let settled = false
    const h = host({ runEffect: async (_b, _t, invoke) => { void invoke() } })
    const running = adapter(h).run(target, () => new Promise<void>(resolve => { finish = resolve })).catch(error => { settled = true; return error })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(settled).toBe(false)
    expect(h.acceptResult).not.toHaveBeenCalled()
    finish()
    expect(await running).toMatchObject({ outcomeUnknown: true })
    expect(settled).toBe(true)
    expect(h.acceptResult).not.toHaveBeenCalled()
  })

  it.each([false, true])('retains an unknown outcome after an effect failure (sync=%s)', async sync => {
    const h = host()
    const effect = vi.fn(() => {
      if (sync) throw new Error('failed')
      return Promise.reject(new Error('failed'))
    })
    await expect(adapter(h).run(target, effect)).rejects.toMatchObject({ outcomeUnknown: true })
    expect(effect).toHaveBeenCalledOnce()
    expect(h.acceptResult).not.toHaveBeenCalled()
  })

  it('does not certify a rejected result or grant follow-up invocation authority', async () => {
    const h = host({ acceptResult: async () => { throw new Error('WRONG_REQUEST') } })
    const effect = vi.fn(async () => {})
    await expect(adapter(h).run(target, effect)).rejects.toMatchObject({ code: 'RESULT_NOT_ACCEPTED', outcomeUnknown: true })
    expect(effect).toHaveBeenCalledOnce()
  })
})

function queueHarness(adapter?: ProjectInvocationAdapter) {
  const clients = new AgentClients(adapter) as any
  const effect = vi.fn(async () => {})
  const agent = { agentId: target.agentId, name: 'Worker', connected: true, projectInvocationBoundary: true as const, replyToMention: () => runProjectInvocationEffect(target, effect), releaseInvocation: vi.fn() }
  clients.rooms.set(target.roomId, new Map([[agent.agentId, agent]]))
  const storage = { enqueueExecutionQueueItem: vi.fn(() => ({ id: target.queueId })), startExecutionQueueItem: vi.fn(() => true), finishExecutionQueueItem: vi.fn() }
  clients._storage = storage
  const message = { messageId: target.messageId!, content: '@Worker work', senderName: 'Owner', senderId: 'member-1', timestamp: 1, role: 'user' as const }
  return { clients, effect, storage, agent, message }
}

describe('actual Group Chat dispatch integration', () => {
  it('preserves default dispatch without installing a host', async () => {
    const q = queueHarness()
    const result = await q.clients.processMentions(target.roomId, q.message)
    expect(q.effect).toHaveBeenCalledOnce()
    expect(result.deliveredCount).toBe(1)
  })

  it('resolves after async preparation and stops a revoked invocation without retry', async () => {
    let finish!: (value: { summary: string; history: [] }) => void
    let revoked = false
    const h = host({ runEffect: async (_b, _t, invoke) => {
      if (revoked) throw new Error('REVOKED')
      await invoke()
    } })
    const q = queueHarness(new ProjectInvocationAdapter(h))
    q.clients.setRoomSummaryService({ prepareForMessage: () => new Promise(resolve => { finish = resolve }) })
    const result = q.clients.processMentions(target.roomId, q.message)
    expect(h.resolve).not.toHaveBeenCalled()
    revoked = true
    finish({ summary: '', history: [] })
    expect(await result).toMatchObject({ deliveredCount: 0, outcomeUnknown: false })
    expect(h.resolve).toHaveBeenCalledWith(target)
    expect(q.effect).not.toHaveBeenCalled()
    expect(q.storage.finishExecutionQueueItem).toHaveBeenCalledWith(target.queueId, 'failed', 'PROJECT_INVOCATION_FAILED')
    expect(q.agent.releaseInvocation).toHaveBeenCalledOnce()
  })

  it('surfaces result rejection as unknown instead of completed queue delivery', async () => {
    const q = queueHarness(new ProjectInvocationAdapter(host({ acceptResult: async () => { throw new Error('NO_RESULT') } })))
    expect(await q.clients.processMentions(target.roomId, q.message)).toMatchObject({ deliveredCount: 0, outcomeUnknown: true })
    expect(q.effect).toHaveBeenCalledOnce()
    expect(q.storage.finishExecutionQueueItem).toHaveBeenCalledWith(target.queueId, 'failed', 'RESULT_NOT_ACCEPTED')
  })
})


describe('bound scope isolation and unsupported executors', () => {
  it('rejects a bound executor with no final-effect seam before calling it', async () => {
    const effect = vi.fn(async () => {})
    await expect(new ProjectInvocationAdapter(host()).run(target, effect)).rejects.toMatchObject({ code: 'NOT_ENABLED', outcomeUnknown: false })
    expect(effect).not.toHaveBeenCalled()
  })

  it('rejects a different invocation identity before the service effect', async () => {
    const effect = vi.fn(async () => {})
    await expect(new ProjectInvocationAdapter(host()).run(target, () => runProjectInvocationEffect({ ...target, agentId: 'other' }, effect), true)).rejects.toMatchObject({ code: 'INVOCATION_TARGET_MISMATCH', outcomeUnknown: false })
    expect(effect).not.toHaveBeenCalled()
  })

  it('retains a caught launch rejection instead of reporting successful completion', async () => {
    const h = host({ runEffect: async () => { throw new Error('REVOKED') } })
    await expect(new ProjectInvocationAdapter(h).run(target, async () => {
      try { await runProjectInvocationEffect(target, async () => {}) } catch { /* legacy handler reports room error */ }
    }, true)).rejects.toMatchObject({ outcomeUnknown: false })
    expect(h.acceptResult).not.toHaveBeenCalled()
  })

  it('does not let an explicitly unbound nested call inherit a bound association', async () => {
    const outer = host()
    const inner = host({ resolve: async () => null })
    const nested = vi.fn(async () => {})
    await new ProjectInvocationAdapter(outer).run(target, async () => {
      await new ProjectInvocationAdapter(inner).run(target, () => runProjectInvocationEffect(target, nested))
      await runProjectInvocationEffect(target, async () => {})
    }, true)
    expect(nested).toHaveBeenCalledOnce()
    expect(outer.runEffect).toHaveBeenCalledOnce()
    expect(inner.runEffect).not.toHaveBeenCalled()
  })
})

const launchMocks = vi.hoisted(() => ({
  capabilities: vi.fn(async () => ({})),
  chat: vi.fn(),
  destroy: vi.fn(async () => {}),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/studio-mcp', () => ({ hermesStudioMcpCapabilities: launchMocks.capabilities }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/model-config', () => ({ resolveBridgeRunModelConfig: vi.fn(async () => ({ model: 'model', provider: 'provider' })) }))
vi.mock('../../packages/server/src/modules/studio/public/group-chat-agent-runtime', () => ({ createGroupPrimaryAgentBridge: () => ({ chat: launchMocks.chat, destroy: launchMocks.destroy }), cancelGroupEkkoClarification: vi.fn() }))

function realClient(agent: 'hermes' | 'codex') {
  const sink = { connected: true, sendMessage: vi.fn(async () => 'error-message'), emit: vi.fn() }
  const client = new AgentClient({ agentId: target.agentId, agent, profile: 'test-profile', name: 'Worker', description: '', invited: 0, backgroundDelegationEnabled: false }, {}, sink)
  client.setStorage({ getRoom: () => ({ id: target.roomId }) })
  return client
}

describe('real AgentClient final launch hooks (fake backends only)', () => {
  it('checks revocation after Hermes capability preparation, before bridge.chat', async () => {
    let ready!: (value: {}) => void
    launchMocks.chat.mockReset()
    launchMocks.capabilities.mockImplementationOnce(() => new Promise(resolve => { ready = resolve }))
    let revoked = false
    const h = host({ runEffect: vi.fn(async (_b, _t, invoke) => { if (revoked) throw new Error('REVOKED'); await invoke() }) })
    const q = queueHarness(new ProjectInvocationAdapter(h))
    q.clients.rooms.set(target.roomId, new Map([[target.agentId, realClient('hermes')]]))
    const result = q.clients.processMentions(target.roomId, q.message)
    await vi.waitFor(() => expect(ready).toBeTypeOf('function'))
    expect(h.runEffect).not.toHaveBeenCalled()
    revoked = true
    ready({})
    expect(await result).toMatchObject({ deliveredCount: 0, outcomeUnknown: false })
    expect(launchMocks.chat).not.toHaveBeenCalled()
    expect(h.acceptResult).not.toHaveBeenCalled()
  })

  it('retains a lost coding-agent invocation acknowledgment as unknown without a second dispatch', async () => {
    const runAndWait = vi.fn(async () => { throw new Error('ACK_LOST') })
    const client = realClient('codex')
    client.setChatRunService({ runAndWait } as any)
    const h = host()
    const q = queueHarness(new ProjectInvocationAdapter(h))
    q.clients.rooms.set(target.roomId, new Map([[target.agentId, client]]))
    expect(await q.clients.processMentions(target.roomId, q.message)).toMatchObject({ deliveredCount: 0, outcomeUnknown: true })
    expect(runAndWait).toHaveBeenCalledOnce()
    expect(h.runEffect).toHaveBeenCalledOnce()
    expect(h.acceptResult).not.toHaveBeenCalled()
    expect(q.storage.finishExecutionQueueItem).toHaveBeenCalledWith(target.queueId, 'failed', 'PROJECT_INVOCATION_FAILED')
  })
})
