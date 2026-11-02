import { freezeEarlierPublicationOwners, currentPublicationLease } from '../../packages/server/src/modules/studio/services/group-chat/publication-authority'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { fsyncSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestGroupChatServer } from './group-chat-test-helpers'
import { config } from '../../packages/server/src/modules/studio/public/config'
import { enrollRecoveryBeforeStart, ENROLLMENT_FAILED } from '../../packages/server/src/modules/studio/services/group-chat/task-recovery-enrollment'
import { recoverCommittedResults } from '../../packages/server/src/modules/studio/services/group-chat/committed-result-recovery'

vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }
})
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const rid = 'personal-enrollment-test-01', mid = 'profile-personal-' + rid
let h: Awaited<ReturnType<typeof createTestGroupChatServer>>, home = '', previousHome = config.appHome
let root = '', receiptRoot = '', policy: any, receipt: any, contract: any, queue: any
const regFile = () => join(home, 'committed-result-recovery/registrations', rid + '.json')
const write = (name: string, value: unknown) => writeFileSync(join(root, name), typeof value === 'string' ? value : JSON.stringify(value))
beforeEach(async () => {
    vi.clearAllMocks()
    previousHome = config.appHome; home = realpathSync(mkdtempSync(join(tmpdir(), 'auto-enroll-'))); config.appHome = home
    h = await createTestGroupChatServer()
    const workspace = join(home, 'workspace'); root = join(workspace, 'profile-tasks/personal', rid)
    receiptRoot = join(home, 'receipts'); mkdirSync(root, { recursive: true }); mkdirSync(receiptRoot)
    mkdirSync(join(home, 'committed-result-recovery'))
    policy = { version: 1, profile: 'personal', ownerAuthUserId: 1, roomId: 'room', targetAgentId: 'worker', workspace, receiptRoot }
    writeFileSync(join(home, 'committed-result-recovery/admission.json'), JSON.stringify(policy))
    const storage = h.groupServer.getStorage()
    storage.saveRoom('room', 'Room', 'CODE', { workspace, ownerAuthUserId: 1 })
    storage.addRoomAgent('room', 'worker', 'default', 'Worker', '', 0, { agent: 'codex' })
    const content = '@Worker one pinned task'
    storage.saveMessageAndRefreshRoom({ id: mid, roomId: 'room', senderId: 'auth:1', senderName: 'Owner', senderType: 'member', role: 'user', content, mentions: [], timestamp: Date.now() } as any)
    write('task.txt', 'one pinned task'); write('delivery_readiness.py', 'checker'); write('recovery.py', 'helper')
    contract = { version: 1, profile: 'personal', request_id: rid, task_sha256: sha('one pinned task'), checker_sha256: sha('checker'), helper_sha256: sha('helper') }; write('contract.json', contract)
    receipt = { id: rid, profile: 'personal', auth_user_id: 1, room_id: 'room', agent_id: 'worker', message_id: mid, task_sha256: contract.task_sha256, message_sha256: sha(content) }
    writeFileSync(join(receiptRoot, rid + '.json'), JSON.stringify(receipt))
    queue = storage.enqueueExecutionQueueItem({ roomId: 'room', messageId: mid, targetAgentId: 'worker', targetAgentName: 'Worker', requesterMemberId: 'auth:1', cancelCapabilityHash: '', textSummary: content })
})
afterEach(() => { h?.cleanup(); config.appHome = previousHome; if (home) rmSync(home, { recursive: true, force: true }) })
function start() { return h.groupServer.getStorage().startExecutionQueueItem(queue.id) }
function blocked() {
    expect(start()).toBe(false)
    expect(h.groupServer.getStorage().getExecutionQueueItem(queue.id)).toMatchObject({ status: 'failed', startedAt: null, lastError: ENROLLMENT_FAILED })
    expect(start()).toBe(false)
}
it('durably registers before admission and repeated starts never run twice', () => {
    expect(start()).toBe(true)
    const reg = JSON.parse(readFileSync(regFile(), 'utf8'))
    const q = h.groupServer.getStorage().getExecutionQueueItem(queue.id)!
    expect(reg).toMatchObject({ admission: 'bridge-admission-v1', queueId: q.id, messageId: mid, requestId: rid, ownerAuthUserId: 1, contractSha256: sha(readFileSync(join(root, 'contract.json'))) })
    expect(reg.enrolledAt).toBeLessThanOrEqual(q.startedAt!)
    expect(fsyncSync).toHaveBeenCalledTimes(3)
    expect(start()).toBe(false); expect(readFileSync(regFile(), 'utf8')).toContain('bridge-admission-v1')
})
it('reconciles durable registration left before DB transition without replacing it', () => {
    enrollRecoveryBeforeStart(h.db, home, queue)
    const before = readFileSync(regFile(), 'utf8'); expect(start()).toBe(true)
    expect(readFileSync(regFile(), 'utf8')).toBe(before)
})
it('fsync failure prevents admission and preserves the partial registration for inspection', () => {
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('IO failed') })
    blocked(); expect(readFileSync(regFile(), 'utf8')).toContain(rid)
})
it('ordinary chat and Milo retain their existing admission path without policy', () => {
    rmSync(join(home, 'committed-result-recovery/admission.json'))
    for (const messageId of ['ordinary-message', 'profile-milo-milo-task-01']) {
        const q = h.groupServer.getStorage().enqueueExecutionQueueItem({ roomId: 'room', messageId, targetAgentId: 'worker', targetAgentName: 'Worker', requesterMemberId: 'auth:1', cancelCapabilityHash: '', textSummary: 'ordinary task' })
        expect(h.groupServer.getStorage().startExecutionQueueItem(q.id)).toBe(true)
    }
})
it.each(['started.json', 'invocations.jsonl', 'sample.json', 'result.json', 'commit.json'])('never admits a task with prior %s', name => { write(name, {}); blocked() })
it.each(['task.txt', 'delivery_readiness.py', 'recovery.py', 'contract.json'])('fails closed on changed %s', name => { write(name, 'changed'); blocked() })
it.each(['auth_user_id', 'room_id', 'agent_id', 'message_id', 'task_sha256', 'message_sha256', 'profile'])('rejects forged receipt %s', key => {
    receipt[key] = 'wrong'; writeFileSync(join(receiptRoot, rid + '.json'), JSON.stringify(receipt)); blocked()
})
it('fails closed when admission policy is missing', () => { rmSync(join(home, 'committed-result-recovery/admission.json')); blocked() })
it('rejects source changes made while queued', () => { h.db.prepare('UPDATE gc_messages SET content=? WHERE id=?').run('changed', mid); blocked() })
it('rejects owner changes', () => { h.db.exec('UPDATE gc_rooms SET ownerAuthUserId=2'); blocked() })
it('rejects removed workers', () => { h.db.exec('UPDATE gc_room_agents SET removedAt=1'); blocked() })
it('rejects receipt symlinks', () => { const file = join(receiptRoot, rid + '.json'); rmSync(file); symlinkSync(join(root, 'contract.json'), file); blocked() })
it('rejects oversized contracts', () => { write('contract.json', ' '.repeat(65537)); blocked() })
it('rejects a non-directory registry', () => { writeFileSync(join(home, 'committed-result-recovery/registrations'), 'blocked'); blocked() })
it('rejects a conflicting registration without replacing it', () => {
    mkdirSync(join(home, 'committed-result-recovery/registrations')); writeFileSync(regFile(), '{"queueId":"other"}')
    blocked(); expect(readFileSync(regFile(), 'utf8')).toBe('{"queueId":"other"}')
})
it.each([false, true])('admission governs context preparation and actual worker invocation (valid=%s)', async valid => {
    if (!valid) rmSync(join(home, 'committed-result-recovery/admission.json'))
    const clients = h.groupServer.agentClients as any
    const prepare = vi.fn(async () => ({ summary: '', history: [] }))
    clients._roomSummaryService = { prepareForMessage: prepare }
    const worker = { agentId: 'worker', name: 'Worker', connected: true, replyToMention: vi.fn(async () => {
        expect(JSON.parse(readFileSync(regFile(), 'utf8')).queueId).toBe(queue.id)
        expect(currentPublicationLease()).toEqual({ queueId: queue.id, epoch: 1 })
    }) }
    const pending = clients.queueMention('room', [worker], { role: 'user', messageId: mid, senderId: 'auth:1', senderName: 'Owner', content: '@Worker one pinned task' })
    await clients._drainRoomQueue('room'); await pending
    expect(prepare).toHaveBeenCalledTimes(valid ? 1 : 0)
    expect(worker.replyToMention).toHaveBeenCalledTimes(valid ? 1 : 0)
})
it.each([false, true])('automatically enrolled task survives restart without dispatch (saved=%s)', saved => {
    expect(start()).toBe(true)
    const q = h.groupServer.getStorage().getExecutionQueueItem(queue.id)!, reg = JSON.parse(readFileSync(regFile(), 'utf8'))
    write('started.json', { request_id: rid, execution_id: 'execution-one', contract_sha256: reg.contractSha256 })
    if (saved) {
        write('sample.json', { evidence_kind: 'live_public_health' }); write('result.json', { scheduled: 'BLOCKED' })
        write('commit.json', { request_id: rid, execution_id: 'execution-one', contract_sha256: reg.contractSha256, exit_code: 1, evaluated_at_utc: new Date(q.startedAt! + 1).toISOString(), hashes: { 'sample.json': sha(readFileSync(join(root, 'sample.json'))), 'result.json': sha(readFileSync(join(root, 'result.json'))) } })
    }
    h.db.prepare("UPDATE gc_execution_queue SET status='failed',finishedAt=? WHERE id=?").run(q.startedAt! + 2, q.id)
    const options = { db: h.db, appHome: home, bootAt: q.startedAt! + 10, persist: vi.fn((m: any) => h.groupServer.getStorage().saveMessageAndRefreshRoom(m)), notify: vi.fn(), report: vi.fn() }
    freezeEarlierPublicationOwners(h.db, options.bootAt)
    recoverCommittedResults(options); recoverCommittedResults(options)
    expect(options.persist).toHaveBeenCalledTimes(saved ? 1 : 0)
    expect(options.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: saved ? 'ALREADY_RETURNED' : 'UNKNOWN_DO_NOT_RETRY' }))
    expect(start()).toBe(false); expect(h.db.prepare('SELECT count(*) n FROM gc_execution_queue').get()!.n).toBe(1)
})
