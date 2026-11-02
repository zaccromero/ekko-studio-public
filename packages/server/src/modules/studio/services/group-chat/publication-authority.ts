import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { RecoveryRegistration } from './committed-result-recovery'

export interface PublicationLease { queueId: string; epoch: number }
type Authority = PublicationLease & { owner: string; binding: string; commitSha256: string | null }
export const STALE_PUBLICATION = 'Publication ownership changed; original execution preserved; do not retry'
const current = new AsyncLocalStorage<PublicationLease | undefined>()
export const currentPublicationLease = () => current.getStore()
export const withPublicationLease = <T>(lease: PublicationLease | undefined, run: () => T): T => current.run(lease, run)
// Event emitters may invoke observers from an unrelated async resource.
export function bindPublicationCallback<A extends unknown[], T>(callback: (...args: A) => T): (...args: A) => T {
    const lease = currentPublicationLease()
    return (...args) => withPublicationLease(lease, () => callback(...args))
}
const check = (value: unknown) => { if (!value) throw new Error(STALE_PUBLICATION) }
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex')

/** Publication authority only: this does not transfer a Kanban claim or invoke a successor. */
export function installPublicationAuthority(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS gc_publication_authority (
        queueId TEXT PRIMARY KEY, epoch INTEGER NOT NULL, owner TEXT NOT NULL,
        binding TEXT NOT NULL, roomId TEXT NOT NULL, agentId TEXT NOT NULL,
        commitSha256 TEXT, changedAt INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS gc_publication_room_update AFTER UPDATE OF ownerAuthUserId,workspace ON gc_rooms
    WHEN OLD.ownerAuthUserId IS NOT NEW.ownerAuthUserId OR OLD.workspace IS NOT NEW.workspace
    BEGIN UPDATE gc_publication_authority SET epoch=epoch+1,owner='revoked',commitSha256=NULL,changedAt=unixepoch()*1000 WHERE roomId=OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS gc_publication_room_delete AFTER DELETE ON gc_rooms
    BEGIN UPDATE gc_publication_authority SET epoch=epoch+1,owner='revoked',commitSha256=NULL,changedAt=unixepoch()*1000 WHERE roomId=OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS gc_publication_agent_update AFTER UPDATE OF ownerMemberId,removedAt,agentId,roomId ON gc_room_agents
    WHEN OLD.ownerMemberId IS NOT NEW.ownerMemberId OR OLD.removedAt IS NOT NEW.removedAt OR OLD.agentId IS NOT NEW.agentId OR OLD.roomId IS NOT NEW.roomId
    BEGIN UPDATE gc_publication_authority SET epoch=epoch+1,owner='revoked',commitSha256=NULL,changedAt=unixepoch()*1000 WHERE roomId=OLD.roomId AND agentId=OLD.agentId; END;
    CREATE TRIGGER IF NOT EXISTS gc_publication_agent_delete AFTER DELETE ON gc_room_agents
    BEGIN UPDATE gc_publication_authority SET epoch=epoch+1,owner='revoked',commitSha256=NULL,changedAt=unixepoch()*1000 WHERE roomId=OLD.roomId AND agentId=OLD.agentId; END;
    CREATE TRIGGER IF NOT EXISTS gc_publication_queue_update AFTER UPDATE OF requesterMemberId,targetAgentId,roomId,messageId ON gc_execution_queue
    WHEN OLD.requesterMemberId IS NOT NEW.requesterMemberId OR OLD.targetAgentId IS NOT NEW.targetAgentId OR OLD.roomId IS NOT NEW.roomId OR OLD.messageId IS NOT NEW.messageId
    BEGIN UPDATE gc_publication_authority SET epoch=epoch+1,owner='revoked',commitSha256=NULL,changedAt=unixepoch()*1000 WHERE queueId=OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS gc_publication_source_update AFTER UPDATE OF roomId,senderId,role,content ON gc_messages
    WHEN OLD.roomId IS NOT NEW.roomId OR OLD.senderId IS NOT NEW.senderId OR OLD.role IS NOT NEW.role OR OLD.content IS NOT NEW.content
    BEGIN UPDATE gc_publication_authority SET epoch=epoch+1,owner='revoked',commitSha256=NULL,changedAt=unixepoch()*1000 WHERE queueId IN (SELECT id FROM gc_execution_queue WHERE messageId=OLD.id); END;
    CREATE TRIGGER IF NOT EXISTS gc_publication_source_delete AFTER DELETE ON gc_messages
    BEGIN UPDATE gc_publication_authority SET epoch=epoch+1,owner='revoked',commitSha256=NULL,changedAt=unixepoch()*1000 WHERE queueId IN (SELECT id FROM gc_execution_queue WHERE messageId=OLD.id); END;
    CREATE TRIGGER IF NOT EXISTS gc_publication_queue_delete AFTER DELETE ON gc_execution_queue
    BEGIN UPDATE gc_publication_authority SET epoch=epoch+1,owner='revoked',commitSha256=NULL,changedAt=unixepoch()*1000 WHERE queueId=OLD.id; END;`)
}

function row(db: DatabaseSync, queueId: string): Authority | undefined {
    return db.prepare('SELECT * FROM gc_publication_authority WHERE queueId=?').get(queueId) as unknown as Authority | undefined
}
function identity(db: DatabaseSync, reg: RecoveryRegistration): void {
    const room = db.prepare('SELECT ownerAuthUserId,workspace FROM gc_rooms WHERE id=?').get(reg.roomId)
    const queue = db.prepare('SELECT * FROM gc_execution_queue WHERE id=?').get(reg.queueId)
    const agent = db.prepare('SELECT removedAt FROM gc_room_agents WHERE roomId=? AND agentId=?').get(reg.roomId, reg.targetAgentId)
    check(room?.ownerAuthUserId === reg.ownerAuthUserId && room.workspace === reg.workspace
        && queue?.roomId === reg.roomId && queue.messageId === reg.messageId
        && queue.targetAgentId === reg.targetAgentId && queue.requesterMemberId === `auth:${reg.ownerAuthUserId}`
        && agent?.removedAt === 0)
}

export function enrollPublicationAuthority(db: DatabaseSync, reg: RecoveryRegistration): PublicationLease {
    const binding = JSON.stringify(reg)
    const existing = row(db, reg.queueId)
    if (existing) check(existing.epoch === 1 && existing.owner === 'worker' && existing.binding === binding)
    else db.prepare("INSERT INTO gc_publication_authority(queueId,epoch,owner,binding,roomId,agentId,changedAt) VALUES (?,1,'worker',?,?,?,?)")
        .run(reg.queueId, binding, reg.roomId, reg.targetAgentId, Date.now())
    return { queueId: reg.queueId, epoch: 1 }
}
export function publicationLease(db: DatabaseSync, queueId: string): PublicationLease | undefined {
    const authority = row(db, queueId)
    if (!authority) return undefined // Ordinary chat and historical registrations are unchanged.
    check(authority.owner === 'worker')
    return { queueId, epoch: authority.epoch }
}
export function assertWorkerPublication(db: DatabaseSync, lease: PublicationLease, roomId?: string, agentId?: string): void {
    const authority = row(db, lease.queueId)
    check(authority && authority.owner === 'worker' && authority.epoch === lease.epoch)
    const reg = JSON.parse(authority!.binding) as RecoveryRegistration
    check((!roomId || roomId === reg.roomId) && (!agentId || agentId === reg.targetAgentId))
    identity(db, reg)
    check(db.prepare('SELECT status FROM gc_execution_queue WHERE id=?').get(lease.queueId)?.status === 'running')
}

// A snapshot pins presence and bytes at the ownership transition, not a worker-supplied timestamp.
// Malformed/missing/unsafe files cannot become recoverable merely by appearing later.
function committedSnapshot(reg: RecoveryRegistration): string | null {
    try {
        let directory = reg.workspace
        for (const part of ['', 'profile-tasks', reg.profile, reg.requestId]) {
            directory = join(directory, part)
            const stat = lstatSync(directory); check(stat.isDirectory() && !stat.isSymbolicLink())
        }
        const fd = openSync(join(directory, 'commit.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
            const stat = fstatSync(fd); check(stat.isFile() && stat.size <= 65536)
            const bytes = Buffer.alloc(65537); let length = 0
            while (length < bytes.length) {
                const count = readSync(fd, bytes, length, bytes.length - length, null)
                if (!count) break
                length += count
            }
            check(length <= 65536)
            return sha(bytes.subarray(0, length))
        } finally { closeSync(fd) }
    } catch { return null }
}

/** Caller holds the same immediate transaction as the authorization check. CAS never reopens a lease. */
export function transferPublicationToRecovery(db: DatabaseSync, queueId: string, expectedEpoch: number, roomId: string, ownerAuthUserId: number): PublicationLease {
    const authority = row(db, queueId)
    check(Number.isSafeInteger(expectedEpoch) && authority?.epoch === expectedEpoch && authority.owner === 'worker')
    const reg = JSON.parse(authority!.binding) as RecoveryRegistration
    check(reg.roomId === roomId && reg.ownerAuthUserId === ownerAuthUserId)
    identity(db, reg)
    const result = db.prepare("UPDATE gc_publication_authority SET epoch=epoch+1,owner='recovery',commitSha256=?,changedAt=? WHERE queueId=? AND epoch=? AND owner='worker'")
        .run(committedSnapshot(reg), Date.now(), queueId, expectedEpoch)
    check(result.changes === 1)
    return { queueId, epoch: expectedEpoch + 1 }
}

export function freezeEarlierPublicationOwners(db: DatabaseSync, bootAt: number): void {
    db.exec('BEGIN IMMEDIATE')
    try {
        const rows = db.prepare("SELECT a.* FROM gc_publication_authority a JOIN gc_execution_queue q ON q.id=a.queueId WHERE a.owner='worker' AND q.startedAt>0 AND q.startedAt<?").all(bootAt) as unknown as Authority[]
        for (const authority of rows) {
            const reg = JSON.parse(authority.binding) as RecoveryRegistration
            transferPublicationToRecovery(db, authority.queueId, authority.epoch, reg.roomId, reg.ownerAuthUserId)
        }
        db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
}

export function assertRecoveryPublication(db: DatabaseSync, reg: RecoveryRegistration, commitSha256: string): void {
    if (!reg.publicationLease) {
        // Historical fixtures/installations may predate the authority table; an enrolled lease cannot be downgraded.
        const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gc_publication_authority'").get()
        check(!table || !row(db, reg.queueId))
        return
    }
    const authority = row(db, reg.queueId)
    check(authority && reg.publicationLease.queueId === reg.queueId
        && authority.owner === 'recovery' && authority.epoch === reg.publicationLease.epoch + 1
        && authority.commitSha256 === commitSha256)
    const binding = JSON.parse(authority!.binding) as Record<string, unknown>
    check(Object.entries(binding).every(([key, value]) => (reg as unknown as Record<string, unknown>)[key] === value))
    identity(db, reg)
}
