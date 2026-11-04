import { expect, it, vi } from 'vitest'
import { HermesRoomGrantClient, selectHermesRoomEndpoint, type HermesRoomIdentity, type HermesRoomInvitation } from '../../packages/server/src/modules/studio/services/group-chat/hermes-room-grant-client'

const identity: HermesRoomIdentity = {
  room_id: 'room_123', home_install_id: 'home_123', authority_gateway_id: 'authority_123',
  authority_epoch: 1, member_id: 'member_123',
}

it('requests one scoped invitation through the bootstrap endpoint', async () => {
  const expiry = Math.floor(Date.now() / 1000) + 3600
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    object: 'hermes.room_member.invitation', grant: 'scoped-grant', target_profile: 'default',
    catalog: { catalog_digest: 'digest' }, expires_at: expiry, status_expires_at: expiry + 3600,
  }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
  const client = new HermesRoomGrantClient('https://hermes.example/private/', () => 'bootstrap-secret', transport)
  const invitation = await client.issue(identity)
  expect(invitation.grant).toBe('scoped-grant')
  expect(transport).toHaveBeenCalledTimes(1)
  expect(String(transport.mock.calls[0][0])).toBe('https://hermes.example/private/v1/room-members/invitations')
  expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual(identity)
  expect(new Headers(transport.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer bootstrap-secret')
})

it('does not follow redirects or turn an HTML fallback into a grant', async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>fallback</html>', {
    status: 200, headers: { 'Content-Type': 'text/html' },
  }))
  const client = new HermesRoomGrantClient('https://hermes.example/', () => 'bootstrap-secret', transport)
  await expect(client.issue(identity)).rejects.toThrow('did not return JSON')
  expect(transport).toHaveBeenCalledTimes(1)
  expect(transport.mock.calls[0][1]?.redirect).toBe('error')
})

it('accepts only the expected installation, profile, and endpoint origin', () => {
  const expiry = Math.floor(Date.now() / 1000) + 3600
  const invitation: HermesRoomInvitation = {
    object: 'hermes.room_member.invitation', grant: 'scoped-grant', target_profile: 'default',
    expires_at: expiry, status_expires_at: expiry + 3600,
    catalog: {
      installation_id: 'target_123', protocol_versions: [2], text: true,
      catalog_digest: 'a'.repeat(64),
      execution_policy: { version: 1, target_profile: 'default', enabled_toolsets: ['bot_room'], approval_mode: 'manual', policy_digest: 'b'.repeat(64) },
      endpoint: { available: true, url: 'https://hermes.example/private/', transport_security: 'tls' },
    },
  }
  const expected = { installId: 'target_123', profile: 'default', origin: 'https://hermes.example' }
  expect(selectHermesRoomEndpoint(invitation, expected)).toMatchObject({
    url: 'https://hermes.example/private/', catalogDigest: 'a'.repeat(64),
  })
  expect(() => selectHermesRoomEndpoint(invitation, { ...expected, origin: 'https://other.example' }))
    .toThrow('outside the trusted origin')
  expect(() => selectHermesRoomEndpoint(invitation, { ...expected, profile: 'other' }))
    .toThrow('does not match the selected target')
  expect(() => selectHermesRoomEndpoint(invitation, { ...expected, policyDigest: 'c'.repeat(64) }))
    .toThrow('execution policy changed')
  expect(() => selectHermesRoomEndpoint({ ...invitation, expires_at: expiry - 7200 }, expected))
    .toThrow('has expired')
  const codingPolicy = { ...(invitation.catalog.execution_policy as Record<string, unknown>), enabled_toolsets: ['bot_room', 'terminal'] }
  expect(() => selectHermesRoomEndpoint({ ...invitation, catalog: { ...invitation.catalog, execution_policy: codingPolicy } }, expected))
    .toThrow('planning-only execution policy')
  const autoApproval = { ...(invitation.catalog.execution_policy as Record<string, unknown>), approval_mode: 'off' }
  expect(() => selectHermesRoomEndpoint({ ...invitation, catalog: { ...invitation.catalog, execution_policy: autoApproval } }, expected))
    .toThrow('planning-only execution policy')
})
