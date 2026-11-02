import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestGroupChatServer, connectGroupChatClient, emitAck } from './group-chat-test-helpers'
import { AgentClient } from '../../packages/server/src/modules/studio/services/group-chat/agent-clients'
import { fixture } from './committed-result-recovery-fixture'
import { enrollPublicationAuthority, assertWorkerPublication, assertRecoveryPublication, transferPublicationToRecovery, freezeEarlierPublicationOwners, withPublicationLease, currentPublicationLease, bindPublicationCallback } from '../../packages/server/src/modules/studio/services/group-chat/publication-authority'
import { recoverCommittedResults } from '../../packages/server/src/modules/studio/services/group-chat/committed-result-recovery'

let h: Awaited<ReturnType<typeof createTestGroupChatServer>>, home: string, f: ReturnType<typeof fixture>
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const commitHash = () => hash(readFileSync(join(f.root, 'commit.json')))
const transfer = (epoch = 1, room = 'room', owner = 1) => {
    h.db.exec('BEGIN IMMEDIATE')
    try { const result = transferPublicationToRecovery(h.db, 'queue', epoch, room, owner); h.db.exec('COMMIT'); return result }
    catch (error) { h.db.exec('ROLLBACK'); throw error }
}
beforeEach(async () => {
    h = await createTestGroupChatServer()
    // Install the synthetic earlier task after the real startup callback has settled.
    await new Promise(resolve => setTimeout(resolve, 0))
    home = realpathSync(mkdtempSync(join(tmpdir(), 'publication-authority-')))
    f = fixture(h.db, home)
    h.db.exec("UPDATE gc_execution_queue SET status='running' WHERE id='queue'")
    f.reg.publicationLease = enrollPublicationAuthority(h.db, f.reg)
    f.saveReg()
})
afterEach(() => { h?.cleanup(); if (home) rmSync(home, { recursive: true, force: true }) })

it('transfers publication without modifying or repeating the original execution', () => {
    const before = h.db.prepare('SELECT * FROM gc_execution_queue').all()
    assertWorkerPublication(h.db, f.reg.publicationLease!, 'room', 'worker')
    expect(transfer()).toEqual({ queueId: 'queue', epoch: 2 })
    expect(() => assertWorkerPublication(h.db, f.reg.publicationLease!)).toThrow('ownership changed')
    assertRecoveryPublication(h.db, f.reg, commitHash())
    expect(h.db.prepare('SELECT * FROM gc_execution_queue').all()).toEqual(before)
    expect(() => transfer()).toThrow()
})
it.each([[0, 'room', 1], [2, 'room', 1], [1, 'other', 1], [1, 'room', 2]])('rejects wrong epoch/room/owner %j', (epoch, room, owner) => {
    expect(() => transfer(Number(epoch), String(room), Number(owner))).toThrow()
    assertWorkerPublication(h.db, f.reg.publicationLease!)
})
it('rejects a delayed normal publication after an earlier successful preflight', () => {
    const storage = h.groupServer.getStorage()
    storage.registerPublicationMessage('room', 'late-result', f.reg.publicationLease!)
    transfer()
    expect(() => storage.saveMessageAndRefreshRoom({ id: 'late-result', roomId: 'room', senderId: 'worker', senderName: 'Worker', role: 'assistant', content: 'stale result', timestamp: Date.now() } as any)).toThrow('ownership changed')
    expect(h.db.prepare("SELECT id FROM gc_messages WHERE id='late-result'").get()).toBeUndefined()
    expect(() => storage.assertPublicationMessage('room', 'late-result', 'worker')).toThrow()
})
it('publishes the current worker and checks sender identity', () => {
    const storage = h.groupServer.getStorage()
    storage.registerPublicationMessage('room', 'current', f.reg.publicationLease!)
    expect(() => storage.saveMessageAndRefreshRoom({ id: 'current', roomId: 'room', senderId: 'other', senderName: 'Other', role: 'assistant', content: 'wrong sender', timestamp: Date.now() } as any)).toThrow()
    storage.saveMessageAndRefreshRoom({ id: 'current', roomId: 'room', senderId: 'worker', senderName: 'Worker', role: 'assistant', content: 'current result', timestamp: Date.now() } as any)
    expect(h.db.prepare("SELECT content FROM gc_messages WHERE id='current'").get()!.content).toBe('current result')
})
it('rejects a late backdated commit while preserving its evidence', () => {
    const commit = readFileSync(join(f.root, 'commit.json'))
    unlinkSync(join(f.root, 'commit.json'))
    transfer()
    writeFileSync(join(f.root, 'commit.json'), commit)
    expect(() => assertRecoveryPublication(h.db, f.reg, commitHash())).toThrow()
    h.db.exec("UPDATE gc_execution_queue SET status='failed' WHERE id='queue'")
    const receipts: any[] = [], notifications: any[] = []
    recoverCommittedResults({ db: h.db, appHome: home, bootAt: f.now, persist: message => { h.groupServer.getStorage().saveMessageAndRefreshRoom(message as any) }, notify: message => notifications.push(message), report: receipt => receipts.push(receipt) })
    expect(receipts[0].status).toBe('UNKNOWN_DO_NOT_RETRY')
    expect(notifications).toEqual([])
    expect(readFileSync(join(f.root, 'commit.json'))).toEqual(commit)
})
it('returns a pre-transfer committed result once on repeated recovery', () => {
    transfer()
    h.db.exec("UPDATE gc_execution_queue SET status='failed' WHERE id='queue'")
    const receipts: any[] = [], notifications: any[] = []
    const recover = () => recoverCommittedResults({ db: h.db, appHome: home, bootAt: f.now, persist: message => { h.groupServer.getStorage().saveMessageAndRefreshRoom(message as any) }, notify: message => notifications.push(message), report: receipt => receipts.push(receipt) })
    recover(); recover()
    expect(receipts.map(r => r.status)).toEqual(['RECOVERED_SAVED_RESULT', 'ALREADY_RETURNED'])
    expect(notifications).toHaveLength(1)
    expect(h.db.prepare('SELECT count(*) n FROM gc_execution_queue').get()!.n).toBe(1)
})
it('freezes commit absence on startup; later startup cannot bless late files', () => {
    const commit = readFileSync(join(f.root, 'commit.json'))
    unlinkSync(join(f.root, 'commit.json'))
    freezeEarlierPublicationOwners(h.db, f.now)
    writeFileSync(join(f.root, 'commit.json'), commit)
    freezeEarlierPublicationOwners(h.db, f.now + 1000)
    expect(() => assertRecoveryPublication(h.db, f.reg, commitHash())).toThrow()
})
it.each([
    "UPDATE gc_rooms SET ownerAuthUserId=2 WHERE id='room'; UPDATE gc_rooms SET ownerAuthUserId=1 WHERE id='room'",
    "UPDATE gc_rooms SET workspace='elsewhere' WHERE id='room'",
    "UPDATE gc_room_agents SET ownerMemberId='auth:2' WHERE agentId='worker'",
    "UPDATE gc_room_agents SET removedAt=99 WHERE agentId='worker'; UPDATE gc_room_agents SET removedAt=0 WHERE agentId='worker'",
    "UPDATE gc_execution_queue SET requesterMemberId='auth:2' WHERE id='queue'; UPDATE gc_execution_queue SET requesterMemberId='auth:1' WHERE id='queue'",
])('irreversibly revokes on changed ownership/binding: %s', sql => {
    h.db.exec(sql)
    expect(() => assertWorkerPublication(h.db, f.reg.publicationLease!)).toThrow()
    expect(() => transfer()).toThrow()
})
it('retains invocation binding across asynchronous work without leaking to another task', async () => {
    await withPublicationLease(f.reg.publicationLease, async () => {
        await Promise.resolve()
        expect(currentPublicationLease()).toEqual(f.reg.publicationLease)
    })
    expect(currentPublicationLease()).toBeUndefined()
})

it('cannot downgrade a new fenced registration to historical legacy recovery', () => {
    transfer()
    const { publicationLease: _lease, ...legacy } = f.reg
    expect(() => assertRecoveryPublication(h.db, legacy, commitHash())).toThrow()
})
it('the actual AgentClient rejects late normal and stream output without a second invocation', async () => {
    const client = new AgentClient({ agentId: 'worker', agent: 'codex', profile: 'default', name: 'Worker', description: '', invited: 0, backgroundDelegationEnabled: false })
    client.setStorage(h.groupServer.getStorage())
    Object.defineProperty(client, 'connected', { get: () => true })
    const emit = vi.fn((_event: string, payload: any, ack?: any) => ack?.({ id: payload.id }))
    ;(client as any).socket = { emit }
    let executions = 0
    await withPublicationLease(f.reg.publicationLease, async () => {
        executions++
        await client.sendMessage('room', 'before transfer', 'preflight', { role: 'assistant' }, 'original-session')
        expect(emit).toHaveBeenCalledTimes(1)
        transfer()
        await expect(async () => client.sendMessage('room', 'late result', 'late', { role: 'assistant' }, 'original-session')).rejects.toThrow('ownership changed')
        expect(() => client.emitMessageStreamStart('room', 'late-stream', 'original-session')).toThrow()
        expect(() => client.emitMessageStreamDelta('room', 'preflight', 'late delta', 'original-session')).toThrow()
        expect(emit).toHaveBeenCalledTimes(1)
    })
    expect(executions).toBe(1)
})
it('the socket requires an authenticated matching owner and rejects stale takeover', async () => {
    const owner = await connectGroupChatClient(h.port, 'auth:1', 'Owner')
    h.sockets.push(owner)
    await emitAck(owner, 'join', { roomId: 'room' })
    const payload = { roomId: 'room', queueId: 'queue', expectedEpoch: 1 }
    expect(await emitAck(owner, 'transfer_task_publication', payload)).toHaveProperty('error')
    const socket = h.groupServer.getIO().of('/group-chat').sockets.get(owner.id!)!
    socket.data.authUser = { id: 2, role: 'super_admin', profiles: ['default'] }
    expect(await emitAck(owner, 'transfer_task_publication', payload)).toHaveProperty('error')
    socket.data.authUser = { id: 1, role: 'user', profiles: ['default'] }
    expect(await emitAck(owner, 'transfer_task_publication', payload)).toMatchObject({ publication: { queueId: 'queue', epoch: 2 }, owner: 'recovery' })
    expect(await emitAck(owner, 'transfer_task_publication', payload)).toHaveProperty('error')
    expect(h.db.prepare('SELECT count(*) n FROM gc_execution_queue').get()!.n).toBe(1)
})

it('binds late external callbacks to the original lease without leaking another task context', async () => {
    const storage = h.groupServer.getStorage()
    const publish = withPublicationLease(f.reg.publicationLease, () => bindPublicationCallback(async () => {
        await Promise.resolve()
        storage.saveMessageAndRefreshRoom({ id: 'external-callback', roomId: 'room', senderId: 'worker', senderName: 'Worker', role: 'tool', content: 'late tool result', timestamp: Date.now() } as any)
    }))
    transfer()
    await withPublicationLease(undefined, async () => {
        await expect(publish()).rejects.toThrow('ownership changed')
        expect(currentPublicationLease()).toBeUndefined()
    })
    expect(h.db.prepare("SELECT id FROM gc_messages WHERE id='external-callback'").get()).toBeUndefined()
})
