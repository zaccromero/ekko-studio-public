import { assertRecoveryPublication, type PublicationLease } from './publication-authority'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/** Operator enrollment, outside agent workspaces. v1 supports Personal readiness artifacts only. */
export interface RecoveryRegistration {
    version: 1
    profile: 'personal'
    requestId: string
    roomId: string
    ownerAuthUserId: number
    messageId: string
    queueId: string
    targetAgentId: string
    workspace: string
    contractSha256: string
    publicationLease?: PublicationLease
}
export interface RecoveryMessage {
    id: string
    roomId: string
    senderId: string
    senderName: string
    senderType: 'member'
    role: 'assistant'
    content: string
    timestamp: number
    mentions: []
}
export interface RecoveryOptions {
    db: DatabaseSync
    appHome: string
    bootAt: number
    persist: (message: RecoveryMessage) => void
    notify: (message: RecoveryMessage) => void
    report: (receipt: { registration: string; status: string; messageId?: string; reason?: string }) => void
}
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const check = (condition: unknown, reason: string): void => { if (!condition) throw new Error(reason) }
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

function directory(path: string): void {
    const stat = lstatSync(path)
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'Non-directory or symlink refused')
}
function read(path: string, limit = 64 * 1024): Buffer {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
        const stat = fstatSync(fd)
        check(stat.isFile() && stat.size <= limit, 'Non-regular or oversized artifact refused')
        const value = Buffer.alloc(limit + 1)
        let length = 0
        while (length < value.length) {
            const count = readSync(fd, value, length, value.length - length, null)
            if (!count) break
            length += count
        }
        check(length <= limit, 'Oversized artifact refused')
        return value.subarray(0, length)
    } finally { closeSync(fd) }
}
function json(value: Buffer): any {
    const parsed = JSON.parse(value.toString('utf8'))
    check(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Expected JSON object')
    return parsed
}

export function recoveryMessageId(roomId: string, requestId: string): string {
    return `gcrecovery_${sha(JSON.stringify([roomId, requestId]))}`
}

function recoverOne(reg: RecoveryRegistration, options: RecoveryOptions): string {
    const { db, bootAt } = options
    check(reg.version === 1 && reg.profile === 'personal', 'Unsupported recovery contract/profile')
    check([reg.requestId, reg.roomId, reg.messageId, reg.queueId, reg.targetAgentId].every(safeId)
        && Number.isSafeInteger(reg.ownerAuthUserId) && reg.ownerAuthUserId > 0
        && hash(reg.contractSha256) && typeof reg.workspace === 'string' && isAbsolute(reg.workspace), 'Invalid registration')
    const room = db.prepare('SELECT ownerAuthUserId,workspace FROM gc_rooms WHERE id=?').get(reg.roomId)
    check(room?.ownerAuthUserId === reg.ownerAuthUserId && room.workspace === reg.workspace, 'Room ownership/workspace changed')
    const source = db.prepare('SELECT roomId,senderId,role FROM gc_messages WHERE id=?').get(reg.messageId)
    check(source?.roomId === reg.roomId && source.senderId === `auth:${reg.ownerAuthUserId}` && source.role === 'user', 'Source message binding mismatch')
    const queue = db.prepare('SELECT * FROM gc_execution_queue WHERE id=?').get(reg.queueId)
    check(queue?.roomId === reg.roomId && queue.messageId === reg.messageId && queue.targetAgentId === reg.targetAgentId
        && queue.requesterMemberId === source?.senderId, 'Queue binding mismatch')
    check(typeof queue?.startedAt === 'number' && queue.startedAt > 0 && queue.startedAt < bootAt
        && typeof queue.finishedAt === 'number' && queue.finishedAt >= queue.startedAt
        && ['completed', 'failed'].includes(String(queue.status)), 'Task not terminal from an earlier boot')
    const agent = db.prepare('SELECT removedAt FROM gc_room_agents WHERE roomId=? AND agentId=?').get(reg.roomId, reg.targetAgentId)
    check(agent && agent.removedAt === 0, 'Original worker no longer belongs to room')
    // Only the last terminal assistant part can acknowledge delivery. Progress/tool-call
    // text may quote the request ID, and a completed queue can still contain an error.
    const lastReply = db.prepare(`SELECT content,finish_reason FROM gc_messages WHERE roomId=? AND senderId=?
        AND role='assistant' AND timestamp>=? AND timestamp<=?
        AND coalesce(finish_reason,'') NOT IN ('streaming','tool_calls')
        ORDER BY timestamp DESC,id DESC LIMIT 1`).get(reg.roomId, reg.targetAgentId, queue!.startedAt, queue!.finishedAt)
    const hasError = db.prepare(`SELECT id FROM gc_messages WHERE roomId=? AND senderId=? AND role='assistant'
        AND timestamp>=? AND timestamp<=? AND (finish_reason='error' OR content LIKE 'Error:%') LIMIT 1`).get(
        reg.roomId, reg.targetAgentId, queue!.startedAt, queue!.finishedAt)
    if (queue!.status === 'completed' && !hasError && lastReply
        && String(lastReply.content).split(/\r?\n/).some(line => line.trim() === `Request ID: ${reg.requestId}`)) {
        return 'NORMAL_RETURN_PRESENT'
    }

    const workspace = resolve(reg.workspace)
    directory(workspace)
    let root = workspace
    for (const part of ['profile-tasks', reg.profile, reg.requestId]) { root = join(root, part); directory(root) }
    const contractBytes = read(join(root, 'contract.json'))
    const contract = json(contractBytes)
    check(sha(contractBytes) === reg.contractSha256 && contract.version === 1 && contract.profile === reg.profile
        && contract.request_id === reg.requestId, 'Pinned contract changed')
    for (const [file, key] of [['task.txt', 'task_sha256'], ['delivery_readiness.py', 'checker_sha256'], ['recovery.py', 'helper_sha256']]) {
        check(hash(contract[key]) && sha(read(join(root, file), 2 * 1024 * 1024)) === contract[key], 'Pinned task source changed')
    }
    const started = json(read(join(root, 'started.json')))
    const commitBytes = read(join(root, 'commit.json'))
    const commit = json(commitBytes)
    check(started.request_id === reg.requestId && commit.request_id === reg.requestId && safeId(started.execution_id)
        && started.execution_id === commit.execution_id && started.contract_sha256 === reg.contractSha256
        && commit.contract_sha256 === reg.contractSha256 && [0, 1, 2].includes(commit.exit_code), 'Execution binding mismatch')
    const committedAt = Date.parse(commit.evaluated_at_utc)
    check(Number.isFinite(committedAt) && committedAt >= Number(queue!.startedAt) && committedAt < bootAt, 'Invalid commit time')
    const sample = read(join(root, 'sample.json'), 2 * 1024 * 1024)
    const result = read(join(root, 'result.json'))
    check(commit.hashes && Object.keys(commit.hashes).sort().join(',') === 'result.json,sample.json'
        && commit.hashes['sample.json'] === sha(sample) && commit.hashes['result.json'] === sha(result), 'Committed artifact integrity mismatch')
    check(json(sample).evidence_kind === 'live_public_health', 'Unsupported sample evidence')
    const savedResult = json(result)
    const message: RecoveryMessage = {
        id: recoveryMessageId(reg.roomId, reg.requestId), roomId: reg.roomId,
        senderId: 'system:committed-result-recovery', senderName: 'Bridge recovery', senderType: 'member',
        role: 'assistant', timestamp: Date.now(), mentions: [],
        content: `Automatic saved-result recovery\nRequest ID: ${reg.requestId}\nExecution ID: ${started.execution_id}\n`
            + `Commit SHA256: ${sha(commitBytes)}\nSaved at: ${commit.evaluated_at_utc}\nWorkload exit: ${commit.exit_code}\n\n`
            + 'PASS: saved artifact integrity. This is historical output, not a fresh health check or independent semantic verification. '
            + 'The original worker outcome is retained separately. No agent was invoked and no workload was retried.\n\n'
            + JSON.stringify(savedResult, null, 2),
    }
    // Serialize check + persistence. Existing storage uses an upsert, so never call it on a collision.
    db.exec('BEGIN IMMEDIATE')
    let published = false
    try {
        assertRecoveryPublication(db, reg, sha(commitBytes))
        const currentRoom = db.prepare('SELECT ownerAuthUserId,workspace FROM gc_rooms WHERE id=?').get(reg.roomId)
        check(currentRoom?.ownerAuthUserId === reg.ownerAuthUserId && currentRoom.workspace === reg.workspace, 'Room changed before publication')
        const existing = db.prepare('SELECT roomId,senderId,role,content FROM gc_messages WHERE id=?').get(message.id)
        if (existing) {
            check(existing.roomId === message.roomId && existing.senderId === message.senderId
                && existing.role === message.role && existing.content === message.content, 'Recovery publication collision')
        } else {
            options.persist(message)
            const stored = db.prepare('SELECT roomId,senderId,role,content FROM gc_messages WHERE id=?').get(message.id)
            check(stored?.roomId === message.roomId && stored.senderId === message.senderId
                && stored.role === message.role && stored.content === message.content, 'Recovery publication not durable')
            published = true
        }
        db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    // A crash here is harmless: room history is the receipt, and another boot will not insert again.
    if (published) options.notify(message)
    return published ? 'RECOVERED_SAVED_RESULT' : 'ALREADY_RETURNED'
}

/** Invoked once by the server lifecycle, not by task/model routing. Never executes task code. */
export function recoverCommittedResults(options: RecoveryOptions): void {
    const directoryPath = join(options.appHome, 'committed-result-recovery', 'registrations')
    let names: string[]
    try {
        directory(join(options.appHome, 'committed-result-recovery'))
        directory(directoryPath)
        names = readdirSync(directoryPath).filter(name => name.endsWith('.json')).sort()
        check(names.length <= 100, 'Recovery registration limit exceeded')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') options.report({ registration: '', status: 'UNKNOWN_DO_NOT_RETRY', reason: 'Invalid recovery registry' })
        return
    }
    for (const name of names) {
        try {
            const reg = json(read(join(directoryPath, name))) as RecoveryRegistration
            const status = recoverOne(reg, options)
            options.report({ registration: name, status, messageId: recoveryMessageId(reg.roomId, reg.requestId) })
        } catch {
            // Do not log artifact content, credentials, or local paths from exception messages.
            options.report({ registration: name, status: 'UNKNOWN_DO_NOT_RETRY', reason: 'Recovery validation or publication failed; original execution preserved' })
        }
    }
}
