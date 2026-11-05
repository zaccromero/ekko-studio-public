export type CloudflarePersonalRoomConfig = {
  roomId: string
  endpointUrl: string
  sourceCommit: string
  credential: () => string
}

const PERSONAL_CLOUD_ORIGIN = 'https://drako-personal-hermes-cloudflare-nemotron.zacc.workers.dev'

/** An exact-room, default-off binding. No Personal secret enters source or room history. */
export function resolveCloudflarePersonalRoomConfig(roomId: string,
  env: Record<string, string | undefined> = process.env): CloudflarePersonalRoomConfig | null {
  const selectedRoom = env.EKKO_CLOUDFLARE_PERSONAL_ROOM_ID?.trim()
  if (!selectedRoom || selectedRoom !== roomId) return null
  const endpointUrl = env.EKKO_CLOUDFLARE_PERSONAL_CHAT_URL?.trim()
  const sourceCommit = env.EKKO_CLOUDFLARE_PERSONAL_SOURCE_COMMIT?.trim()
  const token = env.EKKO_CLOUDFLARE_PERSONAL_INGRESS_TOKEN?.trim()
  if (!endpointUrl || !sourceCommit || !token || /[\r\n]/.test(token)) {
    throw new Error('Cloudflare Personal room binding is incomplete')
  }
  const endpoint = new URL(endpointUrl)
  if (endpoint.origin !== PERSONAL_CLOUD_ORIGIN || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.pathname !== '/v1/chat'
      || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error('Cloudflare Personal room binding is invalid')
  }
  return { roomId, endpointUrl, sourceCommit, credential: () => token }
}
