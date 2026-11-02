import { expect, type TestInfo } from '@playwright/test'
import { test } from './readiness-diagnostics'

test('failure readiness captures pending state without credentials or transcript text', async ({ page, readinessDiagnostics }) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/readiness-fixture', route => route.fulfill({ contentType: 'text/html', body: '<div class="page-loading-overlay">private transcript canary</div><div id="message-51" class="highlight">private message canary</div>' }))
  await page.route('**/api/readiness-probe?**', async route => {
    await gate
    await route.fulfill({ json: { ok: true } })
  })
  await page.goto('/readiness-fixture')
  const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/readiness-probe')
  const fetch = page.evaluate(() => window.fetch('/api/readiness-probe?token=query-secret-canary', {
    method: 'POST', headers: { Authorization: 'Bearer header-secret-canary' }, body: 'body-secret-canary',
  }).then(response => response.json()))
  await requested
  const attachments: Buffer[] = []
  const attach: TestInfo['attach'] = async (_name, options = {}) => { attachments.push(Buffer.from(options.body!)) }
  try {
    await readinessDiagnostics.finish({ status: 'passed', expectedStatus: 'passed', attach })
    expect(attachments).toHaveLength(0)
    await readinessDiagnostics.finish({ status: 'failed', expectedStatus: 'passed', attach })
    expect(attachments).toHaveLength(1)
    const text = attachments[0]!.toString()
    const snapshot = JSON.parse(text)
    expect(snapshot.pending).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'POST', path: '/api/readiness-probe' })]))
    expect(snapshot.dom.elements['.page-loading-overlay'][0].visible).toBe(true)
    expect(snapshot.dom.highlights).toBe(1)
    for (const secret of ['query-secret-canary', 'header-secret-canary', 'body-secret-canary', 'private transcript canary', 'private message canary']) expect(text).not.toContain(secret)
  } finally {
    release()
    await fetch
  }
})
