import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

test('saved recovery output and the original worker failure remain distinct after reload', async ({ page }) => {
  await authenticate(page)
  await mockChatSocket(page)
  await mockHermesApi(page)
  const room = { id: 'recovery-room', name: 'Recovery Room', canManage: true, createdAt: 1 }
  const rows = [
    { id: 'worker-error', roomId: room.id, senderId: 'worker', senderName: 'Worker', senderType: 'agent', role: 'assistant',
      content: 'Error: Coding agent session closed', timestamp: 1000, finish_reason: 'error', run_id: 'original-run' },
    { id: 'saved-recovery', roomId: room.id, senderId: 'system:committed-result-recovery', senderName: 'Bridge recovery', senderType: 'member', role: 'assistant',
      content: 'Automatic saved-result recovery\nRequest ID: personal-test-01\n\nPASS: saved artifact integrity. This is historical output, not a fresh health check or independent semantic verification. The original worker outcome is retained separately. No agent was invoked and no workload was retried.\n\n{"status":"BLOCKED","reason":"transport off"}', timestamp: 2000 },
  ]
  const writes: string[] = []
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/group-chat/')) writes.push(request.url()) })
  await page.route('**/api/studio/group-chat/rooms', route => route.fulfill({ json: { rooms: [room] } }))
  await page.route(/\/api\/studio\/group-chat\/rooms\/recovery-room(?:\?.*)?$/, route => route.fulfill({ json: {
    room, messages: rows, agents: [{ id: 'agent-record', roomId: room.id, agentId: 'worker', name: 'Worker', agent: 'codex', profile: 'default' }],
    members: [], total: 2, hasMore: false,
  } }))
  await page.route('**/api/studio/group-chat/rooms/recovery-room/summary', route => route.fulfill({ json: { summary: null, review: null, anchor: null } }))
  await page.goto('/#/hermes/group-chat/room/recovery-room')
  for (let attempt = 0; attempt < 2; attempt++) {
    const recovery = page.locator('[data-group-message-id="saved-recovery"]')
    await expect(recovery).toHaveCount(1)
    await expect(recovery).toContainText('Automatic saved-result recovery')
    await expect(recovery).toContainText('transport off')
    await expect(page.getByText('Error: Coding agent session closed', { exact: true })).toBeVisible()
    if (!attempt) await page.reload()
  }
  expect(writes).toEqual([])
})
