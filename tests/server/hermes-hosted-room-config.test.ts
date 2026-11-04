import { expect, it } from 'vitest'
import { resolveHermesHostedRoomConfig } from '../../packages/server/src/modules/studio/services/group-chat/hermes-hosted-room-config'

const env = {
  EKKO_HERMES_VM_ROOM_ID: 'room_123',
  EKKO_HERMES_VM_AGENT_ID: 'agent_123',
  EKKO_HERMES_HOME_INSTALL_ID: 'home_123',
  EKKO_HERMES_AUTHORITY_GATEWAY_ID: 'gateway_123',
  EKKO_HERMES_AUTHORITY_EPOCH: '1',
  EKKO_HERMES_VM_TARGET_INSTALL_ID: 'target_123',
  EKKO_HERMES_VM_TARGET_PROFILE: 'default',
  EKKO_HERMES_VM_CATALOG_DIGEST: 'a'.repeat(64),
  EKKO_HERMES_VM_POLICY_DIGEST: 'b'.repeat(64),
  EKKO_HERMES_VM_BOOTSTRAP_URL: 'https://hermes.example/private/',
  EKKO_HERMES_VM_ORIGIN: 'https://hermes.example',
  EKKO_HERMES_VM_BOOTSTRAP_KEY: 'secret-test-value',
}

it('only selects the exact existing room agent with pinned VM identity and policy', () => {
  expect(resolveHermesHostedRoomConfig('other_room', 'agent_123', env)).toBeNull()
  expect(resolveHermesHostedRoomConfig('room_123', 'other_agent', env)).toBeNull()
  const selected = resolveHermesHostedRoomConfig('room_123', 'agent_123', env)
  expect(selected?.identity).toMatchObject({ room_id: 'room_123', member_id: 'agent_123', authority_epoch: 1 })
  expect(selected?.target).toMatchObject({
    installId: 'target_123', catalogDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64),
  })
  expect(selected?.credential()).toBe('secret-test-value')
})

it('fails closed for a selected room with missing key or endpoint drift', () => {
  expect(() => resolveHermesHostedRoomConfig('room_123', 'agent_123', {
    ...env, EKKO_HERMES_VM_AGENT_ID: undefined,
  })).toThrow('AGENT_ID is missing')
  expect(() => resolveHermesHostedRoomConfig('room_123', 'agent_123', {
    ...env, EKKO_HERMES_VM_BOOTSTRAP_KEY: undefined,
  })).toThrow('BOOTSTRAP_KEY is missing')
  expect(() => resolveHermesHostedRoomConfig('room_123', 'agent_123', {
    ...env, EKKO_HERMES_VM_BOOTSTRAP_URL: 'https://other.example/private/',
  })).toThrow('outside the trusted origin')
})
