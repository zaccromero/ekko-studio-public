import { expect, it, vi } from 'vitest'
import { classifyHermesRun, hasHermesCompleteTextReply, HermesAdmissionUnknownError, HermesRunApiClient, type HermesHostedRoomDispatch, type HermesRunStatus } from '../../packages/server/src/modules/studio/services/group-chat/hermes-run-api-client'

const dispatch: HermesHostedRoomDispatch = {
  protocol_version: 2,
  room_id: 'room_123',
  home_install_id: 'home_123',
  authority_gateway_id: 'authority_123',
  authority_epoch: 1,
  member_id: 'member_123',
  target_install_id: 'target_123',
  target_profile: 'default',
  task_id: 'task_123',
  execution_generation: 1,
  source_event_seq: 1,
  cancellation_scope_id: 'cancel_123',
  prompt: 'Plan the next step',
  prompt_digest: 'fixture_digest',
  capability_digest: 'fixture_capability',
  execution_policy_digest: 'fixture_policy',
  trace_id: 'trace_123',
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

it('admits exactly one keyed run and reads only the matching run ID', async () => {
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(json({ run_id: 'run_123', status: 'started', replayed: false }, 202))
    .mockResolvedValueOnce(json({ object: 'hermes.run', run_id: 'run_123', status: 'completed' }))
  const client = new HermesRunApiClient('https://hermes.example/private/', () => 'scoped-token', transport)

  expect(await client.submitRoomDispatch(dispatch)).toMatchObject({ run_id: 'run_123' })
  expect(await client.status('run_123')).toMatchObject({ run_id: 'run_123', status: 'completed' })
  expect(transport).toHaveBeenCalledTimes(2)
  expect(String(transport.mock.calls[0][0])).toBe('https://hermes.example/private/v1/runs')
  const admission = transport.mock.calls[0][1]
  expect(admission?.method).toBe('POST')
  expect(new Headers(admission?.headers).get('Idempotency-Key')).toBe('room:task_123:1')
  expect(new Headers(admission?.headers).get('Authorization')).toBe('HermesRoom scoped-token')
  expect(new Headers(transport.mock.calls[1][1]?.headers).get('Authorization')).toBe('HermesRoom scoped-token')
  expect(JSON.parse(String(admission?.body))).toEqual({ input: dispatch.prompt, hosted_room_dispatch: dispatch })
})

it('rejects a mismatched status and never submits another run during status readback', async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(json({ object: 'hermes.run', run_id: 'other', status: 'completed' }))
  const client = new HermesRunApiClient('https://hermes.example/', () => 'scoped-token', transport)
  await expect(client.status('run_123')).rejects.toThrow('mismatched run status')
  expect(transport).toHaveBeenCalledTimes(1)
  expect(transport.mock.calls[0][1]?.method).toBe('GET')
})

it('rejects HTML fallback and nonlocal plaintext transport', async () => {
  expect(() => new HermesRunApiClient('http://hermes.example/', () => 'token')).toThrow('requires HTTPS')
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>fallback</html>', {
    headers: { 'Content-Type': 'text/html' },
  }))
  const client = new HermesRunApiClient('http://127.0.0.1:8642/', () => 'token', transport)
  await expect(client.status('run_123')).rejects.toThrow('did not return JSON')
})

it('keeps approval, failure, and unknown statuses distinct from completed work', () => {
  const status = (value: string): HermesRunStatus => ({ object: 'hermes.run', run_id: 'run_123', status: value })
  expect(classifyHermesRun(status('completed'))).toBe('completed')
  expect(classifyHermesRun(status('waiting_for_approval'))).toBe('needs_approval')
  expect(classifyHermesRun(status('interrupted'))).toBe('failed')
  expect(classifyHermesRun(status('running'))).toBe('pending')
  expect(classifyHermesRun(status('unexpected'))).toBe('unknown')
})

it('accepts canonical completed text without optional flags but rejects explicit incomplete states', () => {
  const projected = { object: 'hermes.run', run_id: 'run_123', status: 'completed', output: 'A finished plan' }
  expect(hasHermesCompleteTextReply(projected)).toBe(true)
  expect(hasHermesCompleteTextReply({ ...projected, completed: false })).toBe(false)
  expect(hasHermesCompleteTextReply({ ...projected, partial: true })).toBe(false)
  expect(hasHermesCompleteTextReply({ ...projected, status: 'running' })).toBe(false)
  expect(hasHermesCompleteTextReply({ ...projected, output: '   ' })).toBe(false)
})

it('does not retry an uncertain admission or invent a second idempotency key', async () => {
  const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection lost after send'))
  const client = new HermesRunApiClient('https://hermes.example/', () => 'scoped-token', transport)
  await expect(client.submitRoomDispatch(dispatch)).rejects.toMatchObject({
    name: 'HermesAdmissionUnknownError',
    idempotencyKey: 'room:task_123:1',
  })
  expect(transport).toHaveBeenCalledTimes(1)
  expect(new Headers(transport.mock.calls[0][1]?.headers).get('Idempotency-Key')).toBe('room:task_123:1')
})
