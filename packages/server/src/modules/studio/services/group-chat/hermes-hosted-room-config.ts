import type { ExpectedHermesRoomTarget, HermesRoomIdentity } from './hermes-room-grant-client'

export type HermesHostedRoomConfig = {
  roomId: string
  agentId: string
  bootstrapUrl: string
  credential: () => string
  identity: HermesRoomIdentity
  target: ExpectedHermesRoomTarget
}

const id = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/
const digest = /^[a-f0-9]{64}$/

/** Exact room/Agent opt-in. A partial selected configuration fails closed. */
export function resolveHermesHostedRoomConfig(
  roomId: string, agentId: string, env: Record<string, string | undefined> = process.env,
): HermesHostedRoomConfig | null {
  const selectedRoom = env.EKKO_HERMES_VM_ROOM_ID?.trim()
  if (!selectedRoom || selectedRoom !== roomId) return null
  const selectedAgent = env.EKKO_HERMES_VM_AGENT_ID?.trim()
  if (!selectedAgent) throw new Error('Hermes VM room setting EKKO_HERMES_VM_AGENT_ID is missing')
  if (selectedAgent !== agentId) return null
  const required = (key: string): string => {
    const value = env[key]?.trim()
    if (!value) throw new Error(`Hermes VM room setting ${key} is missing`)
    return value
  }
  const homeInstall = required('EKKO_HERMES_HOME_INSTALL_ID')
  const authorityGateway = required('EKKO_HERMES_AUTHORITY_GATEWAY_ID')
  const epoch = Number(required('EKKO_HERMES_AUTHORITY_EPOCH'))
  const targetInstall = required('EKKO_HERMES_VM_TARGET_INSTALL_ID')
  const targetProfile = required('EKKO_HERMES_VM_TARGET_PROFILE')
  const catalogDigest = required('EKKO_HERMES_VM_CATALOG_DIGEST')
  const policyDigest = required('EKKO_HERMES_VM_POLICY_DIGEST')
  const bootstrapUrl = required('EKKO_HERMES_VM_BOOTSTRAP_URL')
  const origin = required('EKKO_HERMES_VM_ORIGIN')
  const bootstrapKey = required('EKKO_HERMES_VM_BOOTSTRAP_KEY')
  if (![roomId, agentId, homeInstall, authorityGateway, targetInstall, targetProfile].every(value => id.test(value))
      || !Number.isSafeInteger(epoch) || epoch <= 0
      || !digest.test(catalogDigest) || !digest.test(policyDigest)
      || /[\r\n]/.test(bootstrapKey)) throw new Error('Invalid Hermes VM room identity or digest')
  const base = new URL(bootstrapUrl)
  const trustedOrigin = new URL(origin)
  if (base.origin !== trustedOrigin.origin || base.username || base.password || base.search || base.hash
      || trustedOrigin.username || trustedOrigin.password
      || trustedOrigin.pathname !== '/' || trustedOrigin.search || trustedOrigin.hash
      || (base.protocol !== 'https:' && !(base.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw new Error('Hermes VM bootstrap endpoint is outside the trusted origin')
  }
  return {
    roomId, agentId, bootstrapUrl, credential: () => bootstrapKey,
    identity: {
      room_id: roomId, home_install_id: homeInstall, authority_gateway_id: authorityGateway,
      authority_epoch: epoch, member_id: agentId,
    },
    target: {
      installId: targetInstall, profile: targetProfile, origin: trustedOrigin.origin,
      catalogDigest, policyDigest,
    },
  }
}
