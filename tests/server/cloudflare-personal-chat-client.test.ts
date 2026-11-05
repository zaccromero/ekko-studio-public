import { describe, expect, it, vi } from 'vitest'
import { CloudflarePersonalChatClient, CloudflarePersonalChatError } from '../../packages/server/src/modules/studio/services/group-chat/cloudflare-personal-chat-client'

const requestId = 'f58e3c36-9076-4577-afbd-09073b9574ec'
const sourceCommit = '2a91274c93752f250d9bf7e486e0ddd2649d16d8'
const result = {
  ok: true, answer: 'Bounded reply', correlationId: 'correlation-1', idempotencyKey: requestId,
  runtimeInstanceId: 'runtime-1', sourceCommit, cloudflareVersionId: 'version-1',
}
const health = {
  healthy: true, identity: 'drako.hermes.personal', ingressAuthenticationConfigured: true,
  sourceCommit, persistedSourceCommit: sourceCommit,
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
})

describe('Cloudflare Personal chat client', () => {
  it('pins HTTPS route, key and read-only request shape', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json(health)).mockResolvedValueOnce(json(result))
    const client = new CloudflarePersonalChatClient('https://personal.example/v1/chat', sourceCommit, () => 'secret', transport)
    await expect(client.ask('What is the current status?', requestId)).resolves.toMatchObject(result)
    expect(String(transport.mock.calls[0][0])).toBe('https://personal.example/health')
    expect(String(transport.mock.calls[1][0])).toBe('https://personal.example/v1/chat')
    const options = transport.mock.calls[1][1]!
    expect(options.redirect).toBe('error')
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer secret')
    expect(new Headers(options.headers).get('Idempotency-Key')).toBe(requestId)
    expect(JSON.parse(String(options.body))).toEqual({ question: 'What is the current status?', requested_capabilities: [] })
  })

  it('rejects route changes and mismatched or non-JSON replies', async () => {
    expect(() => new CloudflarePersonalChatClient('http://personal.example/v1/chat', sourceCommit, () => 'secret')).toThrow()
    expect(() => new CloudflarePersonalChatClient('https://personal.example/v1/creative-director', sourceCommit, () => 'secret')).toThrow()
    expect(() => new CloudflarePersonalChatClient('https://personal.example/v1/chat', 'unknown', () => 'secret')).toThrow()
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(health)).mockResolvedValueOnce(json({ ...result, idempotencyKey: crypto.randomUUID() }))
    const client = new CloudflarePersonalChatClient('https://personal.example/v1/chat', sourceCommit, () => 'secret', transport)
    await expect(client.ask('Question', requestId)).rejects.toMatchObject({
      message: 'Personal cloud chat returned a mismatched reply', outcome: 'unknown',
    })
    transport.mockResolvedValueOnce(json(health)).mockResolvedValueOnce(json({ ...result, sourceCommit: 'a'.repeat(40) }))
    await expect(client.ask('Question', requestId)).rejects.toMatchObject({ outcome: 'unknown' })
    transport.mockResolvedValueOnce(json(health)).mockResolvedValueOnce(new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }))
    await expect(client.ask('Question', requestId)).rejects.toMatchObject({
      message: 'Personal cloud chat did not return JSON', outcome: 'unknown',
    })
  })

  it('keeps a duplicate or lost response at outcome unknown', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":{"code":"duplicate_request"}}', {
      status: 409, headers: { 'content-type': 'application/json' },
    }))
    transport.mockResolvedValueOnce(json(health))
    const client = new CloudflarePersonalChatClient('https://personal.example/v1/chat', sourceCommit, () => 'secret', transport)
    await expect(client.ask('Question', requestId)).rejects.toMatchObject({ outcome: 'unknown' })
    transport.mockResolvedValueOnce(json(health)).mockRejectedValueOnce(new TypeError('connection lost'))
    await expect(client.ask('Question', requestId)).rejects.toBeInstanceOf(CloudflarePersonalChatError)
    expect(transport).toHaveBeenCalledTimes(4)
  })

  it('does not transmit a question when the live Cloudflare source changes', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(json({ ...health, sourceCommit: 'a'.repeat(40) }))
    const client = new CloudflarePersonalChatClient('https://personal.example/v1/chat', sourceCommit, () => 'secret', transport)
    await expect(client.ask('Question', requestId)).rejects.toMatchObject({ outcome: 'refused' })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('reads a confirmed result from the result route without replaying chat', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json(health))
      .mockResolvedValueOnce(json({ status:'ready', ...result }))
    const client = new CloudflarePersonalChatClient('https://personal.example/v1/chat', sourceCommit, () => 'secret', transport)
    await expect(client.readResult('Question',requestId)).resolves.toEqual({ status:'ready',reply:result })
    expect(transport.mock.calls.map(call => String(call[0]))).toEqual([
      'https://personal.example/health','https://personal.example/v1/chat/result',
    ])
    expect(JSON.parse(String(transport.mock.calls[1][1]?.body))).toEqual({ question:'Question',requested_capabilities:[] })
  })

  it('keeps pending and mismatched result lookups out of the room', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(health)).mockResolvedValueOnce(json({ status:'pending',sourceCommit },202))
      .mockResolvedValueOnce(json(health)).mockResolvedValueOnce(json({ status:'ready',...result,idempotencyKey:crypto.randomUUID() }))
    const client = new CloudflarePersonalChatClient('https://personal.example/v1/chat', sourceCommit, () => 'secret', transport)
    await expect(client.readResult('Question',requestId)).resolves.toEqual({ status:'pending' })
    await expect(client.readResult('Question',requestId)).rejects.toMatchObject({ outcome:'unknown' })
    expect(transport.mock.calls.every(call => String(call[0]) !== 'https://personal.example/v1/chat')).toBe(true)
  })
})
