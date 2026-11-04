import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { buildHermesHostedRoomDispatch } from '../../packages/server/src/modules/studio/services/group-chat/hermes-hosted-room-dispatch'

const expiry = Math.floor(Date.now() / 1000) + 3600
const identity = {
  room_id: 'room_123', home_install_id: 'home_123', authority_gateway_id: 'authority_123',
  authority_epoch: 1, member_id: 'member_123',
}
const invitation = {
  object: 'hermes.room_member.invitation' as const, grant: 'scoped-grant', target_profile: 'default',
  expires_at: expiry, status_expires_at: expiry + 3600,
  catalog: {
    installation_id: 'target_123', protocol_versions: [2], text: true,
    catalog_digest: 'a'.repeat(64),
    execution_policy: { version: 1, target_profile: 'default', enabled_toolsets: ['bot_room'], approval_mode: 'manual', policy_digest: 'b'.repeat(64) },
    endpoint: { available: true, url: 'https://hermes.example/private/', transport_security: 'tls' },
  },
}
const target = { installId: 'target_123', profile: 'default', origin: 'https://hermes.example' }
const task = {
  taskId: 'task_123', executionGeneration: 1, sourceEventSeq: 7,
  cancellationScopeId: 'cancel_123', prompt: 'Plan the next step', traceId: 'trace_123',
}

it('binds the scoped grant, target, prompt digest and task identity into protocol v2', () => {
  const result = buildHermesHostedRoomDispatch(identity, invitation, target, task)
  expect(result.endpointUrl).toBe('https://hermes.example/private/')
  expect(result.grant).toBe('scoped-grant')
  expect(result.dispatch).toMatchObject({
    protocol_version: 2, room_id: 'room_123', target_install_id: 'target_123',
    task_id: 'task_123', execution_generation: 1, source_event_seq: 7,
    capability_digest: 'a'.repeat(64), execution_policy_digest: 'b'.repeat(64),
    prompt_digest: createHash('sha256').update(task.prompt).digest('hex'),
  })
  expect(() => buildHermesHostedRoomDispatch(identity, invitation, target, { ...task, taskId: '../bad' }))
    .toThrow('Invalid Hermes hosted-room task binding')
})
