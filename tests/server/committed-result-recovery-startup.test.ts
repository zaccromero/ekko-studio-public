import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestGroupChatServer } from './group-chat-test-helpers'
import { fixture } from './committed-result-recovery-fixture'
import { GroupChatServer } from '../../packages/server/src/modules/studio/sockets/group-chat'
import { config } from '../../packages/server/src/modules/studio/public/config'

let harness: Awaited<ReturnType<typeof createTestGroupChatServer>> | undefined
let home = '', previousHome = config.appHome
const servers: GroupChatServer[] = []
afterEach(() => {
    for (const server of servers) server.getIO().close()
    servers.length = 0
    harness?.cleanup(); harness = undefined
    config.appHome = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
})
it('server startup returns saved output, preserves interrupted failure and never dispatches', async () => {
    previousHome = config.appHome
    home = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-startup-recovery-')))
    config.appHome = home
    harness = await createTestGroupChatServer()
    const f = fixture(harness.db, home)
    harness.db.exec("UPDATE gc_execution_queue SET status='running',finishedAt=NULL")
    const start = () => {
        const server = new GroupChatServer(createServer())
        servers.push(server)
        return vi.spyOn((server as any).agentClients, 'processMentions')
    }
    const dispatch = start()
    await vi.waitFor(() => expect(harness!.db.prepare("SELECT count(*) n FROM gc_messages WHERE senderId='system:committed-result-recovery'").get()!.n).toBe(1))
    const recovered = harness.db.prepare("SELECT content FROM gc_messages WHERE senderId='system:committed-result-recovery'").get()!
    expect(recovered.content).toContain('transport off')
    expect(recovered.content).toContain('Automatic saved-result recovery')
    expect(harness.db.prepare("SELECT status,lastError FROM gc_execution_queue").get()).toMatchObject({ status: 'failed', lastError: 'Studio restarted while work was running' })
    expect(harness.db.prepare("SELECT content FROM gc_messages WHERE id='error'").get()!.content).toBe(f.error)
    expect(dispatch).not.toHaveBeenCalled()
    const secondDispatch = start()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(harness.db.prepare("SELECT count(*) n FROM gc_messages WHERE senderId='system:committed-result-recovery'").get()!.n).toBe(1)
    expect(harness.db.prepare('SELECT count(*) n FROM gc_execution_queue').get()!.n).toBe(1)
    expect(secondDispatch).not.toHaveBeenCalled()
})
