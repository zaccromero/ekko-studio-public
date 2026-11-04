/** Trusted setup exchange for a scoped VM room grant. Never called from a room message. */
export type HermesRoomIdentity = {
  room_id: string
  home_install_id: string
  authority_gateway_id: string
  authority_epoch: number
  member_id: string
}

export type HermesRoomInvitation = {
  object: 'hermes.room_member.invitation'
  grant: string
  target_profile: string
  catalog: Record<string, unknown>
  expires_at: number
  status_expires_at: number
}

export type QualifiedHermesRoomEndpoint = {
  url: string
  catalogDigest: string
  executionPolicyDigest: string
}

export type ExpectedHermesRoomTarget = {
  installId: string
  profile: string
  origin: string
  catalogDigest?: string
  policyDigest?: string
}

/** Shape and destination gate; the VM still verifies the grant, catalog and policy digests. */
export function selectHermesRoomEndpoint(
  invitation: HermesRoomInvitation,
  expected: ExpectedHermesRoomTarget,
): QualifiedHermesRoomEndpoint {
  const now = Date.now() / 1000
  if (!Number.isFinite(invitation.expires_at) || invitation.expires_at <= now
      || !Number.isFinite(invitation.status_expires_at) || invitation.status_expires_at < invitation.expires_at) {
    throw new Error('Hermes room invitation has expired')
  }
  const catalog = invitation.catalog
  const policy = catalog.execution_policy
  const endpoint = catalog.endpoint
  if (invitation.target_profile !== expected.profile
      || catalog.installation_id !== expected.installId
      || !Array.isArray(catalog.protocol_versions) || !catalog.protocol_versions.includes(2)
      || catalog.text !== true
      || !policy || typeof policy !== 'object' || Array.isArray(policy)
      || (policy as Record<string, unknown>).target_profile !== expected.profile
      || !endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    throw new Error('Hermes room catalog does not match the selected target')
  }
  // Ordinary room publication has no protected project-result verifier. Only a
  // target-issued, tool-limited planning policy may use this return path.
  const roomPolicy = policy as Record<string, unknown>
  if (roomPolicy.version !== 1
      || !Array.isArray(roomPolicy.enabled_toolsets)
      || roomPolicy.enabled_toolsets.length !== 1
      || roomPolicy.enabled_toolsets[0] !== 'bot_room'
      || roomPolicy.approval_mode !== 'manual') {
    throw new Error('Hermes hosted room requires a planning-only execution policy')
  }
  const fields = endpoint as Record<string, unknown>
  const digest = catalog.catalog_digest
  const policyDigest = (policy as Record<string, unknown>).policy_digest
  if (fields.available !== true || typeof fields.url !== 'string'
      || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)
      || typeof policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(policyDigest)) {
    throw new Error('Hermes room endpoint is unavailable or lacks digest fields')
  }
  if ((expected.catalogDigest && digest !== expected.catalogDigest)
      || (expected.policyDigest && policyDigest !== expected.policyDigest)) {
    throw new Error('Hermes room catalog or execution policy changed')
  }
  const url = new URL(fields.url)
  const origin = new URL(expected.origin)
  const security = url.protocol === 'https:' ? 'tls' : 'loopback'
  if (url.origin !== origin.origin || url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      || fields.transport_security !== security) {
    throw new Error('Hermes room endpoint is outside the trusted origin')
  }
  return { url: url.toString(), catalogDigest: digest, executionPolicyDigest: policyDigest }
}

export class HermesRoomGrantClient {
  private readonly base: URL

  constructor(
    baseUrl: string,
    private readonly bootstrapCredential: () => string,
    private readonly transport: typeof fetch = fetch,
  ) {
    const base = new URL(baseUrl)
    if (!['https:', 'http:'].includes(base.protocol)) throw new Error('Unsupported Hermes room API protocol')
    if (base.username || base.password || base.search || base.hash) throw new Error('Room API base URL must not contain credentials, query, or fragment')
    if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
      throw new Error('Remote Hermes room API requires HTTPS')
    }
    this.base = new URL(base.toString().replace(/\/*$/, '/'))
  }

  async issue(identity: HermesRoomIdentity): Promise<HermesRoomInvitation> {
    if (!Object.values(identity).every(value => value !== '' && value !== undefined && value !== null)
        || !Number.isSafeInteger(identity.authority_epoch) || identity.authority_epoch <= 0) {
      throw new Error('Invalid Hermes room authority identity')
    }
    const credential = this.bootstrapCredential()
    if (!credential || /[\r\n]/.test(credential)) throw new Error('Hermes room bootstrap credential is unavailable')
    const response = await this.transport(new URL('v1/room-members/invitations', this.base), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(identity),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      throw new Error('Hermes room invitation did not return JSON')
    }
    if (response.status !== 201) throw new Error(`Hermes room invitation returned HTTP ${response.status}`)
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hermes room invitation is invalid')
    const result = value as Record<string, unknown>
    if (result.object !== 'hermes.room_member.invitation' || typeof result.grant !== 'string' || !result.grant
        || typeof result.target_profile !== 'string' || !result.target_profile
        || !result.catalog || typeof result.catalog !== 'object' || Array.isArray(result.catalog)
        || typeof result.expires_at !== 'number' || !Number.isFinite(result.expires_at)
        || result.expires_at <= Date.now() / 1000
        || typeof result.status_expires_at !== 'number' || !Number.isFinite(result.status_expires_at)
        || result.status_expires_at < result.expires_at) {
      throw new Error('Hermes room invitation is invalid')
    }
    return {
      object: 'hermes.room_member.invitation', grant: result.grant,
      target_profile: result.target_profile, catalog: result.catalog as Record<string, unknown>,
      expires_at: result.expires_at, status_expires_at: result.status_expires_at,
    }
  }
}
