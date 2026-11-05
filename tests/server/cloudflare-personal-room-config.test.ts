import { describe, expect, it } from 'vitest'
import { resolveCloudflarePersonalRoomConfig } from '../../packages/server/src/modules/studio/services/group-chat/cloudflare-personal-room-config'

const env = {
  EKKO_CLOUDFLARE_PERSONAL_ROOM_ID: 'bridge-1',
  EKKO_CLOUDFLARE_PERSONAL_CHAT_URL: 'https://drako-personal-hermes-cloudflare-nemotron.zacc.workers.dev/v1/chat',
  EKKO_CLOUDFLARE_PERSONAL_SOURCE_COMMIT: '2a91274c93752f250d9bf7e486e0ddd2649d16d8',
  EKKO_CLOUDFLARE_PERSONAL_INGRESS_TOKEN: 'secret-for-test',
}

describe('Cloudflare Personal room binding', () => {
  it('is off by default and bound to one exact room', () => {
    expect(resolveCloudflarePersonalRoomConfig('bridge-1', {})).toBeNull()
    expect(resolveCloudflarePersonalRoomConfig('other-room', env)).toBeNull()
    expect(resolveCloudflarePersonalRoomConfig('bridge-1', env)?.credential()).toBe('secret-for-test')
  })

  it('rejects incomplete, redirected or credential-bearing destinations', () => {
    expect(() => resolveCloudflarePersonalRoomConfig('bridge-1', {
      ...env, EKKO_CLOUDFLARE_PERSONAL_INGRESS_TOKEN: undefined,
    })).toThrow('incomplete')
    for (const url of ['http://example.com/v1/chat','https://u:p@example.com/v1/chat',
      'https://example.com/v1/chat?x=1','https://example.com/other']) {
      expect(() => resolveCloudflarePersonalRoomConfig('bridge-1', {
        ...env, EKKO_CLOUDFLARE_PERSONAL_CHAT_URL: url,
      })).toThrow('invalid')
    }
  })
})
