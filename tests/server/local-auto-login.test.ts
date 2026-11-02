import { describe, expect, it } from 'vitest'
import {
  isLocalAutoLoginEnabled,
  isTrustedLocalBrowserRequest,
  type LocalAutoLoginRequest,
} from '../../packages/server/src/modules/studio/services/auth/local-auto-login'

const browser: LocalAutoLoginRequest = {
  remoteAddress: '127.0.0.1',
  host: 'localhost:8648',
  origin: 'http://localhost:8648',
  secFetchSite: 'same-origin',
  port: 8648,
}

describe('isLocalAutoLoginEnabled', () => {
  it('is off unless explicitly set to 1', () => {
    expect(isLocalAutoLoginEnabled({})).toBe(false)
    expect(isLocalAutoLoginEnabled({ EKKO_LOCAL_AUTO_LOGIN: 'true' })).toBe(false)
    expect(isLocalAutoLoginEnabled({ EKKO_LOCAL_AUTO_LOGIN: '1' })).toBe(true)
  })
})

describe('isTrustedLocalBrowserRequest', () => {
  it('accepts a same-origin browser request on this machine', () => {
    expect(isTrustedLocalBrowserRequest(browser)).toBe(true)
    expect(isTrustedLocalBrowserRequest({
      ...browser,
      remoteAddress: '::ffff:127.0.0.1',
      host: '127.0.0.1:8648',
      origin: 'http://127.0.0.1:8648',
    })).toBe(true)
  })

  it('rejects a LAN peer', () => {
    expect(isTrustedLocalBrowserRequest({ ...browser, remoteAddress: '10.0.0.48' })).toBe(false)
  })

  it('rejects relay-forwarded requests, which carry no origin or fetch metadata', () => {
    expect(isTrustedLocalBrowserRequest({
      ...browser,
      host: '127.0.0.1:8648',
      origin: undefined,
      secFetchSite: undefined,
    })).toBe(false)
  })

  it('rejects a cross-site page calling localhost', () => {
    expect(isTrustedLocalBrowserRequest({
      ...browser,
      origin: 'https://evil.example',
      secFetchSite: 'cross-site',
    })).toBe(false)
    expect(isTrustedLocalBrowserRequest({ ...browser, secFetchSite: 'same-site' })).toBe(false)
  })

  it('rejects DNS-rebinding hosts even when origin matches them', () => {
    expect(isTrustedLocalBrowserRequest({
      ...browser,
      host: 'evil.example:8648',
      origin: 'http://evil.example:8648',
    })).toBe(false)
  })

  it('rejects another local port and a mismatched origin', () => {
    expect(isTrustedLocalBrowserRequest({
      ...browser,
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
    })).toBe(false)
    expect(isTrustedLocalBrowserRequest({ ...browser, origin: 'http://localhost:3000' })).toBe(false)
  })
})
