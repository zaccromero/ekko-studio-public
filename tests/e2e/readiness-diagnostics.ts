import { test as base, type Page, type Request, type TestInfo } from '@playwright/test'

type RequestState = { method: string; path: string; kind: string; started: number; status?: number; outcome?: string; elapsed?: number }
type AttachmentContext = Pick<TestInfo, 'status' | 'expectedStatus' | 'attach'>

export function startReadinessDiagnostics(page: Page) {
  const started = Date.now()
  const pending = new Map<Request, RequestState>()
  const recent: RequestState[] = []
  const pageErrors: string[] = []
  let dropped = 0
  const remember = (entry: RequestState) => { recent.push(entry); if (recent.length > 80) recent.shift() }
  const onRequest = (request: Request) => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return
    if (!['document', 'script', 'fetch', 'xhr'].includes(request.resourceType())) return
    if (pending.size >= 100) {
      pending.delete(pending.keys().next().value!)
      dropped++
    }
    // Never retain query strings, headers, bodies, remote URLs or absolute local paths.
    const path = url.pathname.startsWith('/@fs/') ? `/@fs/[local]/${url.pathname.split('/').at(-1)}` : url.pathname
    pending.set(request, { method: request.method(), path, kind: request.resourceType(), started: Date.now() - started })
  }
  const settle = (request: Request, outcome: string) => {
    const entry = pending.get(request)
    if (!entry) return
    pending.delete(request)
    remember({ ...entry, outcome, elapsed: Date.now() - started - entry.started })
  }
  const onResponse = (response: { request(): Request; status(): number }) => {
    const entry = pending.get(response.request())
    if (entry) entry.status = response.status()
  }
  const onFinished = (request: Request) => settle(request, 'finished')
  const onFailed = (request: Request) => settle(request, 'failed')
  const onError = (error: Error) => {
    const name = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError'].includes(error.name) ? error.name : 'Error'
    pageErrors.push(name)
    if (pageErrors.length > 20) pageErrors.shift()
  }
  page.on('request', onRequest)
  page.on('response', onResponse)
  page.on('requestfinished', onFinished)
  page.on('requestfailed', onFailed)
  page.on('pageerror', onError)
  const capture = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let dom: unknown
    try {
      dom = await Promise.race([
        page.evaluate(() => {
          const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
          const selectors = ['.page-loading-overlay', '.message-search-loading', '.virtual-message-list-host', '.header-session-menu-trigger', '.session-list', '.workflow-sidebar', '.room-sidebar', 'aside.sidebar', '.hermes-config-sidebar', '.ekko-config-sidebar', '.coding-agent-config-sidebar']
          return {
            readyState: document.readyState,
            visibility: document.visibilityState,
            route: location.hash.split('?')[0],
            viewport: { width: innerWidth, height: innerHeight },
            messageRows: document.querySelectorAll('[id^="message-"]').length,
            highlights: document.querySelectorAll('[id^="message-"].highlight').length,
            elements: Object.fromEntries(selectors.map(selector => [selector, [...document.querySelectorAll(selector)].slice(0, 3).map(element => {
              const { x, y, width, height } = element.getBoundingClientRect()
              const { display, visibility, opacity } = getComputedStyle(element)
              return { visible: visible(element), display, visibility, opacity, x, y, width, height }
            })])),
          }
        }),
        new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: 'snapshot timeout' }), 1000) }),
      ])
    } catch { dom = { unavailable: 'page unavailable' } }
    finally { if (timer) clearTimeout(timer) }
    return { elapsed: Date.now() - started, dom, pending: [...pending.values()], recent, pageErrors, dropped }
  }
  return {
    capture,
    async finish(info: AttachmentContext) {
      if (info.status === info.expectedStatus) return
      await info.attach('readiness-diagnostics', { body: Buffer.from(JSON.stringify(await capture(), null, 2)), contentType: 'application/json' })
    },
    dispose() {
      page.off('request', onRequest)
      page.off('response', onResponse)
      page.off('requestfinished', onFinished)
      page.off('requestfailed', onFailed)
      page.off('pageerror', onError)
    },
  }
}

export const test = base.extend<{ readinessDiagnostics: ReturnType<typeof startReadinessDiagnostics> }>({
  readinessDiagnostics: [async ({ page }, use, info) => {
    const diagnostics = startReadinessDiagnostics(page)
    try { await use(diagnostics) }
    finally {
      try { await diagnostics.finish(info) }
      finally { diagnostics.dispose() }
    }
  }, { auto: true }],
})
