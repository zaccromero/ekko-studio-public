import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { recoverCommittedResults, recoveryMessageId, type RecoveryOptions } from '../../packages/server/src/modules/studio/services/group-chat/committed-result-recovery'

import { fixture } from './committed-result-recovery-fixture'

describe('automatic committed-result recovery', () => {
    let home: string, db: DatabaseSync, f: ReturnType<typeof fixture>, options: RecoveryOptions
    beforeEach(() => {
        home = realpathSync(mkdtempSync(join(tmpdir(), 'committed-recovery-')))
        db = new DatabaseSync(':memory:')
        db.exec(`CREATE TABLE gc_rooms(id TEXT PRIMARY KEY,name TEXT,workspace TEXT,ownerAuthUserId INTEGER,createdAt INTEGER);
            CREATE TABLE gc_messages(id TEXT PRIMARY KEY,roomId TEXT,senderId TEXT,senderName TEXT,role TEXT,content TEXT,timestamp INTEGER,finish_reason TEXT);
            CREATE TABLE gc_room_agents(id TEXT,roomId TEXT,agentId TEXT,name TEXT,agent TEXT,profile TEXT,removedAt INTEGER);
            CREATE TABLE gc_execution_queue(id TEXT PRIMARY KEY,roomId TEXT,messageId TEXT,targetAgentId TEXT,targetAgentName TEXT,requesterMemberId TEXT,textSummary TEXT,sequence INTEGER,status TEXT,createdAt INTEGER,startedAt INTEGER,finishedAt INTEGER);`)
        f = fixture(db, home)
        options = { db, appHome: home, bootAt: f.now,
            persist: vi.fn(m => { db.prepare('INSERT INTO gc_messages (id,roomId,senderId,senderName,role,content,timestamp) VALUES (?,?,?,?,?,?,?)')
                .run(m.id, m.roomId, m.senderId, m.senderName, m.role, m.content, m.timestamp) }), notify: vi.fn(), report: vi.fn() }
    })
    afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }) })
    const count = () => Number(db.prepare("SELECT count(*) n FROM gc_messages WHERE senderId='system:committed-result-recovery'").get()!.n)
    const run = () => recoverCommittedResults(options)
    function unknown() { run(); expect(count()).toBe(0); expect(options.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'UNKNOWN_DO_NOT_RETRY' })) }

    it('returns once across repeated startup, retaining failed worker and queue', () => {
        run(); run()
        expect(count()).toBe(1); expect(options.persist).toHaveBeenCalledTimes(1); expect(options.notify).toHaveBeenCalledTimes(1)
        expect(options.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ALREADY_RETURNED' }))
        expect(db.prepare("SELECT content FROM gc_messages WHERE id='error'").get()!.content).toBe(f.error)
        expect(db.prepare("SELECT status FROM gc_execution_queue").get()!.status).toBe('failed')
        expect(db.prepare('SELECT count(*) n FROM gc_execution_queue').get()!.n).toBe(1)
    })
    it('rolls back interrupted persistence and returns on next boot without losing the result', () => {
        const persist = options.persist
        options.persist = m => { persist(m); throw new Error('power lost before commit') }
        unknown(); options.persist = persist; run(); expect(count()).toBe(1)
    })
    it('retains durable room history after a post-commit notification failure', () => {
        options.notify = vi.fn(() => { throw new Error('socket closed') })
        run(); run(); expect(count()).toBe(1); expect(options.persist).toHaveBeenCalledTimes(1)
        expect(options.notify).toHaveBeenCalledTimes(1)
    })
    it('refuses message ID collisions without replacing the existing message', () => {
        const id = recoveryMessageId('room', f.reg.requestId)
        db.prepare('INSERT INTO gc_messages(id,content) VALUES (?,?)').run(id, 'unrelated')
        unknown(); expect(db.prepare('SELECT content FROM gc_messages WHERE id=?').get(id)!.content).toBe('unrelated')
    })
    it.each(['commit.json', 'started.json', 'sample.json'])('does not retry a claim missing %s', name => { rmSync(join(f.root, name)); unknown() })
    it.each(['result.json', 'task.txt', 'delivery_readiness.py', 'recovery.py', 'contract.json'])('refuses changed %s', name => { writeFileSync(join(f.root, name), '{}'); unknown() })
    it.each(['result.json', 'contract.json'])('refuses a symlink %s', name => {
        const file = join(f.root, name), original = readFileSync(file), outside = join(home, 'outside')
        writeFileSync(outside, original); rmSync(file); symlinkSync(outside, file); unknown()
    })
    it('refuses symlink directories', () => {
        const root = f.root; rmSync(root, { recursive: true }); symlinkSync(home, root); unknown()
    })
    it('refuses oversized result', () => { writeFileSync(join(f.root, 'result.json'), 'x'.repeat(65537)); unknown() })
    it.each(['running', 'queued', 'cancelled', 'unknown'])('refuses queue status %s', status => { db.prepare('UPDATE gc_execution_queue SET status=?').run(status); unknown() })
    it.each(['ownerAuthUserId', 'workspace'])('refuses changed room %s', column => {
        db.prepare(`UPDATE gc_rooms SET ${column}=?`).run(column === 'ownerAuthUserId' ? 2 : '/another'); unknown()
    })
    it('refuses changed source owner', () => { db.exec("UPDATE gc_messages SET senderId='auth:2' WHERE id='source'"); unknown() })
    it('refuses changed queue target', () => { db.exec("UPDATE gc_execution_queue SET targetAgentId='another'"); unknown() })
    it('refuses another profile', () => { (f.reg as any).profile = 'milo'; f.saveReg(); unknown() })
    it('refuses changed execution ID', () => { f.write('commit.json', { ...f.commit, execution_id: 'another' }); unknown() })
    it('does not recover execution from this boot', () => { options.bootAt = f.now - 3500; unknown() })
    it('suppresses a normal request-tagged worker return', () => {
        db.prepare("UPDATE gc_messages SET content=?,finish_reason='stop' WHERE id='error'").run(`Finished.\nRequest ID: ${f.reg.requestId}`)
        db.exec("UPDATE gc_execution_queue SET status='completed'")
        run(); expect(count()).toBe(0); expect(options.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'NORMAL_RETURN_PRESENT' }))
    })
    it.each(['streaming', 'tool_calls'])('does not mistake %s text for a normal return', finish => {
        db.exec("UPDATE gc_execution_queue SET status='completed'; DELETE FROM gc_messages WHERE id='error'")
        db.prepare("INSERT INTO gc_messages(id,roomId,senderId,role,content,timestamp,finish_reason) VALUES ('progress','room','worker','assistant',?,?,?)")
            .run(`Request ID: ${f.reg.requestId}`, f.now - 1000, finish)
        run(); expect(count()).toBe(1)
    })
    it('does not mistake progress followed by a worker error for a successful return', () => {
        db.exec("UPDATE gc_execution_queue SET status='completed'")
        db.prepare("INSERT INTO gc_messages(id,roomId,senderId,role,content,timestamp) VALUES ('progress','room','worker','assistant',?,?)")
            .run(`Request ID: ${f.reg.requestId}`, f.now - 2000)
        run(); expect(count()).toBe(1)
    })
    it('has no effect without operator enrollment', () => { rmSync(f.registry, { recursive: true }); run(); expect(count()).toBe(0); expect(options.report).not.toHaveBeenCalled() })
})
