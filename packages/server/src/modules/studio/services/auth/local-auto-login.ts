/**
 * Opt-in password-free login for a single-user install opened in a browser on
 * the same machine. Off unless EKKO_LOCAL_AUTO_LOGIN=1.
 *
 * Loopback alone is NOT sufficient here: the app relays (cloud and LAN) forward
 * remote requests to http://127.0.0.1:<port>. Every check below therefore also
 * requires headers only a real same-origin browser request carries and that the
 * relays never forward (their header allowlists exclude origin, host and
 * sec-fetch-*):
 *  - socket peer is loopback (raw socket, never a forwarded header)
 *  - Host is localhost/127.0.0.1 on our port (defeats DNS rebinding)
 *  - Origin equals http://<Host> (a cross-site page cannot forge it)
 *  - Sec-Fetch-Site is same-origin (browser-set, not settable by page script)
 */

export interface LocalAutoLoginRequest {
  remoteAddress: string | undefined
  host: string | undefined
  origin: string | undefined
  secFetchSite: string | undefined
  port: number
}

export function isLocalAutoLoginEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.EKKO_LOCAL_AUTO_LOGIN?.trim() === '1'
}

function isLoopbackAddress(value: string | undefined): boolean {
  const address = String(value || '').trim().replace(/^::ffff:/, '')
  return address === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)
}

export function isTrustedLocalBrowserRequest(req: LocalAutoLoginRequest): boolean {
  if (!isLoopbackAddress(req.remoteAddress)) return false

  const host = String(req.host || '').trim().toLowerCase()
  const allowedHosts = [`localhost:${req.port}`, `127.0.0.1:${req.port}`]
  if (!allowedHosts.includes(host)) return false

  const origin = String(req.origin || '').trim().toLowerCase()
  if (origin !== `http://${host}`) return false

  return String(req.secFetchSite || '').trim().toLowerCase() === 'same-origin'
}
