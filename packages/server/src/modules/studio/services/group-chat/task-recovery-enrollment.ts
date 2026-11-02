import { enrollPublicationAuthority } from './publication-authority'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { RecoveryRegistration } from './committed-result-recovery'

export const ENROLLMENT_FAILED = 'Recovery enrollment failed; worker not started'
const check = (value: unknown): void => { if (!value) throw new Error(ENROLLMENT_FAILED) }
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(v)
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
interface Queue {
    id: string; roomId: string; messageId: string; targetAgentId: string
    requesterMemberId: string; status: string; startedAt: number | null
}
function directory(root: string, parts: string[] = []): string {
    let current = root
    for (const part of ['', ...parts]) {
        current = join(current, part)
        const stat = lstatSync(current)
        check(stat.isDirectory() && !stat.isSymbolicLink())
    }
    return current
}
function read(file: string, limit = 65536): Buffer {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
        const stat = fstatSync(fd); check(stat.isFile() && stat.size <= limit)
        const bytes = Buffer.alloc(limit + 1); let length = 0
        while (length < bytes.length) {
            const count = readSync(fd, bytes, length, bytes.length - length, null)
            if (!count) break
            length += count
        }
        check(length <= limit)
        return bytes.subarray(0, length)
    } finally { closeSync(fd) }
}
function object(bytes: Buffer): any {
    const value = JSON.parse(bytes.toString('utf8'))
    check(value && typeof value === 'object' && !Array.isArray(value))
    return value
}
function absent(file: string): void {
    try { lstatSync(file) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    throw new Error(ENROLLMENT_FAILED)
}
function sync(file: string): void {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** Called inside queued-to-running's transaction. Never executes or retries work.
 * The operator-owned policy/receipts are cooperative same-user trust, not an OS sandbox.
 * Personal v1 is deliberately opt-in by the existing relay message namespace.
 */
export function enrollRecoveryBeforeStart(db: DatabaseSync, appHome: string, queue: Queue): void {
    if (!queue.messageId.startsWith('profile-personal-')) return
    const match = /^profile-personal-([a-z0-9][a-z0-9-]{7,79})$/.exec(queue.messageId)
    check(match && queue.status === 'queued' && queue.startedAt === null)
    const requestId = match![1]
    const base = directory(appHome, ['committed-result-recovery'])
    const policy = object(read(join(base, 'admission.json')))
    check(policy.version === 1 && policy.profile === 'personal'
        && Number.isSafeInteger(policy.ownerAuthUserId) && policy.ownerAuthUserId > 0
        && [policy.roomId, policy.targetAgentId].every(id)
        && typeof policy.workspace === 'string' && isAbsolute(policy.workspace) && resolve(policy.workspace) === policy.workspace
        && typeof policy.receiptRoot === 'string' && isAbsolute(policy.receiptRoot) && resolve(policy.receiptRoot) === policy.receiptRoot)
    check(queue.roomId === policy.roomId && queue.targetAgentId === policy.targetAgentId
        && queue.requesterMemberId === `auth:${policy.ownerAuthUserId}`)
    const room = db.prepare('SELECT ownerAuthUserId,workspace FROM gc_rooms WHERE id=?').get(queue.roomId)
    const source = db.prepare('SELECT roomId,senderId,role,content FROM gc_messages WHERE id=?').get(queue.messageId)
    const agent = db.prepare('SELECT agent,removedAt FROM gc_room_agents WHERE roomId=? AND agentId=?').get(queue.roomId, queue.targetAgentId)
    check(room?.ownerAuthUserId === policy.ownerAuthUserId && room?.workspace === policy.workspace
        && source?.roomId === queue.roomId && source.senderId === queue.requesterMemberId && source.role === 'user'
        && agent?.agent === 'codex' && agent.removedAt === 0)
    const receiptRoot = directory(policy.receiptRoot)
    const receipt = object(read(join(receiptRoot, requestId + '.json')))
    check(receipt.id === requestId && receipt.profile === 'personal' && receipt.auth_user_id === policy.ownerAuthUserId
        && receipt.message_id === queue.messageId && receipt.room_id === queue.roomId && receipt.agent_id === queue.targetAgentId
        && hash(receipt.message_sha256) && sha(String(source!.content)) === receipt.message_sha256)
    const root = directory(policy.workspace, ['profile-tasks', 'personal', requestId])
    const contractBytes = read(join(root, 'contract.json')), contract = object(contractBytes)
    check(contract.version === 1 && contract.profile === 'personal' && contract.request_id === requestId
        && hash(receipt.task_sha256) && receipt.task_sha256 === contract.task_sha256)
    for (const [file, key] of [['task.txt', 'task_sha256'], ['delivery_readiness.py', 'checker_sha256'], ['recovery.py', 'helper_sha256']]) {
        check(hash(contract[key]) && sha(read(join(root, file), 2097152)) === contract[key])
    }
    // Any prior invocation/claim/output is ambiguous. Admission cannot clear or replay it.
    for (const file of ['invocations.jsonl', 'started.json', 'sample.json', 'result.json', 'commit.json']) absent(join(root, file))
    const registration: RecoveryRegistration = { version: 1, profile: 'personal', requestId,
        roomId: queue.roomId, ownerAuthUserId: policy.ownerAuthUserId, messageId: queue.messageId,
        queueId: queue.id, targetAgentId: queue.targetAgentId, workspace: policy.workspace,
        contractSha256: sha(contractBytes) }
    registration.publicationLease = enrollPublicationAuthority(db, registration)
    const registry = join(base, 'registrations')
    try { mkdirSync(registry, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    directory(registry)
    const file = join(registry, requestId + '.json')
    let fd: number | undefined
    try {
        fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        writeFileSync(fd, JSON.stringify({ ...registration, admission: 'bridge-admission-v1', enrolledAt: Date.now() }))
        fsyncSync(fd)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = object(read(file))
        check(existing.admission === 'bridge-admission-v1' && Number.isSafeInteger(existing.enrolledAt)
            && existing.enrolledAt > 0 && existing.enrolledAt <= Date.now()
            && Object.entries(registration).every(([key, value]) => JSON.stringify(existing[key]) === JSON.stringify(value)))
        sync(file)
    } finally { if (fd !== undefined) closeSync(fd) }
    // Persist both creation of registrations/ and its new entry before admitting work.
    sync(registry); sync(base)
}
