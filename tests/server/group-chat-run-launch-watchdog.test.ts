import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentClient,
  withRunLaunchWatchdog,
} from '../../packages/server/src/modules/studio/services/group-chat/agent-clients'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('withRunLaunchWatchdog', () => {
  it('passes a run result through', async () => {
    const onStall = vi.fn()
    await expect(withRunLaunchWatchdog(Promise.resolve('done'), () => false, 50, onStall, 'Codex')).resolves.toBe('done')
    expect(onStall).not.toHaveBeenCalled()
  })

  it('cancels a run that emitted nothing before the timeout', async () => {
    const onStall = vi.fn()
    await expect(withRunLaunchWatchdog(new Promise(() => {}), () => false, 20, onStall, 'Codex'))
      .rejects.toThrow('Codex did not start within')
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('never cancels a run that has started, however long it takes', async () => {
    let finish!: (value: string) => void
    const run = new Promise<string>(resolve => { finish = resolve })
    const onStall = vi.fn()
    const watched = withRunLaunchWatchdog(run, () => true, 20, onStall, 'Codex')
    await new Promise(resolve => setTimeout(resolve, 60))
    finish('late but fine')
    await expect(watched).resolves.toBe('late but fine')
    expect(onStall).not.toHaveBeenCalled()
  })
})

function codexClient() {
  const sink = { connected: true, id: 'socket', sendMessage: vi.fn(async () => 'id'), emit: vi.fn() }
  const client = new AgentClient({
    agent: 'codex', agentMode: 'global', profile: 'default', name: 'Codex', description: '',
    invited: Date.now(), backgroundDelegationEnabled: false,
  } as any, {}, sink)
  client.setStorage({ getRoom: () => ({ id: 'room', workspace: '' }) })
  return { client, sink }
}

describe('group run launch watchdog', () => {
  it('fails a silent run with a visible error and aborts its session', async () => {
    vi.stubEnv('GROUP_CHAT_RUN_LAUNCH_TIMEOUT_MS', '30')
    const { client, sink } = codexClient()
    const abortSession = vi.fn(async () => {})
    client.setChatRunService({
      runAndWait: vi.fn(() => new Promise(() => {})),
      abortSession,
      disposeSession: vi.fn(async () => {}),
    } as any)

    await client.replyToMention('room', {
      messageId: 'm1', content: '@Codex hi', senderId: 'human', senderName: 'Zacc', timestamp: 1, role: 'user',
    })

    expect(abortSession).toHaveBeenCalledWith(expect.stringMatching(/^gc_run_room_default_Codex_/), 'Run did not start within the launch timeout')
    const errorPost = sink.sendMessage.mock.calls.find(call => (call[3] as any)?.finish_reason === 'error')
    expect(errorPost?.[1]).toMatch(/Codex did not start within/)
  })

  it('leaves a run alone once it has emitted any event', async () => {
    vi.stubEnv('GROUP_CHAT_RUN_LAUNCH_TIMEOUT_MS', '30')
    const { client } = codexClient()
    const abortSession = vi.fn(async () => {})
    client.setChatRunService({
      runAndWait: vi.fn((_data: any, options: any) => new Promise(resolve => {
        options.onEvent('run.queued', {})
        setTimeout(() => resolve({ ok: true, run_id: 'r1', output: 'ok', reasoning: '' }), 80)
      })),
      abortSession,
      disposeSession: vi.fn(async () => {}),
    } as any)

    await client.replyToMention('room', {
      messageId: 'm1', content: '@Codex hi', senderId: 'human', senderName: 'Zacc', timestamp: 1, role: 'user',
    })

    expect(abortSession).not.toHaveBeenCalledWith(expect.anything(), 'Run did not start within the launch timeout')
  })
})
