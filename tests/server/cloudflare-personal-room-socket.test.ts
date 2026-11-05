import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectGroupChatClient, createTestGroupChatServer, emitAck } from './group-chat-test-helpers'

const sourceCommit = '2a91274c93752f250d9bf7e486e0ddd2649d16d8'
const envNames = [
  'EKKO_CLOUDFLARE_PERSONAL_ROOM_ID', 'EKKO_CLOUDFLARE_PERSONAL_CHAT_URL',
  'EKKO_CLOUDFLARE_PERSONAL_SOURCE_COMMIT', 'EKKO_CLOUDFLARE_PERSONAL_INGRESS_TOKEN',
] as const

describe('Cloudflare Personal room socket', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]))

  beforeEach(async () => {
    harness = await createTestGroupChatServer()
    harness.groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1', { ownerAuthUserId: 1 })
    process.env.EKKO_CLOUDFLARE_PERSONAL_ROOM_ID = 'room-1'
    process.env.EKKO_CLOUDFLARE_PERSONAL_CHAT_URL = 'https://drako-personal-hermes-cloudflare-nemotron.zacc.workers.dev/v1/chat'
    process.env.EKKO_CLOUDFLARE_PERSONAL_SOURCE_COMMIT = sourceCommit
    process.env.EKKO_CLOUDFLARE_PERSONAL_INGRESS_TOKEN = 'test-only-token'
  })

  afterEach(() => {
    harness?.cleanup()
    vi.unstubAllGlobals()
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name]
      else process.env[name] = originalEnv[name]
    }
  })

  it('rejects a room guest before saving or sending', async () => {
    const guest = await connectGroupChatClient(harness.port, 'guest', 'Guest', { authUserId: 2 })
    harness.sockets.push(guest)
    await emitAck(guest, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    const serverSocket = harness.groupServer.getIO().of('/group-chat').sockets.get(guest.id!)!
    serverSocket.data.authUser = { id: 2, role: 'admin' }
    const transport = vi.fn()
    vi.stubGlobal('fetch', transport)
    const result = await emitAck<{ error?: string }>(guest, 'message', {
      roomId: 'room-1', id: 'guest-cloud', content: '/cloud show status',
    })
    expect(result.error).toContain('authenticated room owner')
    expect(harness.db.prepare('SELECT 1 FROM gc_messages WHERE id=?').get('guest-cloud')).toBeUndefined()
    expect(transport).not.toHaveBeenCalled()
  })

  it('saves one sourced external answer without routing the four agents', async () => {
    const owner = await connectGroupChatClient(harness.port, 'owner', 'Owner', { authUserId: 1 })
    harness.sockets.push(owner)
    await emitAck(owner, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    const serverSocket = harness.groupServer.getIO().of('/group-chat').sockets.get(owner.id!)!
    serverSocket.data.authUser = { id: 1, role: 'admin' }
    const processMentions = vi.spyOn(harness.groupServer.agentClients, 'processMentions')
    const transport = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/health') return Response.json({ healthy: true,
        identity: 'drako.hermes.personal', ingressAuthenticationConfigured: true,
        sourceCommit, persistedSourceCommit: sourceCommit })
      expect(init.method).toBe('POST')
      expect(init.headers).toMatchObject({ Authorization: 'Bearer test-only-token' })
      expect(JSON.parse(String(init.body))).toEqual({ question: 'show status', requested_capabilities: [] })
      return Response.json({ ok: true, answer: 'Cloud answer', correlationId: 'corr-1',
        idempotencyKey: (init.headers as Record<string,string>)['Idempotency-Key'],
        runtimeInstanceId: 'runtime-1', sourceCommit, cloudflareVersionId: 'version-1' })
    })
    vi.stubGlobal('fetch', transport)
    const result = await emitAck<{ id?: string; error?: string }>(owner, 'message', {
      roomId: 'room-1', id: 'owner-cloud', content: '/cloud show status',
    })
    expect(result).toEqual({ id: 'owner-cloud' })
    await vi.waitFor(() => expect(harness.db.prepare(
      "SELECT state FROM gc_cloud_personal_turns WHERE sourceMessageId='owner-cloud'",
    ).get()).toEqual({ state: 'published' }))
    const answer = harness.db.prepare("SELECT senderType,senderName,content FROM gc_messages WHERE senderId='cloudflare-personal'")
      .all() as Array<{ senderType: string; senderName: string; content: string }>
    expect(answer).toHaveLength(1)
    expect(answer[0]).toMatchObject({ senderType: 'external', senderName: 'Cloudflare Personal · external result' })
    expect(answer[0].content).toContain('Cloud answer')
    expect(processMentions).not.toHaveBeenCalled()
    expect(transport).toHaveBeenCalledTimes(2)
  })
})
