import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

export type HermesHostedRoomRun = {
  queueId: string
  roomId: string
  messageId: string
  targetAgentId: string
  taskId: string
  generation: number
  sourceEventSeq: number
  promptDigest: string
  scopeJson: string
  ownerAuthUserId: number
  requesterMemberId: string
  sourceDigest: string
  agentOwnerMemberId: string
  runId: string | null
  terminalJson: string | null
  publishedMessageId: string | null
  publishedAt: number | null
  deliveryMode: 'public' | 'private'
  state: 'reserved' | 'admission_unknown' | 'admitted' | 'completed' | 'failed'
  createdAt: number
  updatedAt: number
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/
const digest = /^[a-f0-9]{64}$/

/** Persistent intent before network submission; contains no bearer grant or bootstrap key. */
export function installHermesHostedRoomLedger(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS gc_hermes_hosted_room_runs (
    queueId TEXT PRIMARY KEY, roomId TEXT NOT NULL, messageId TEXT NOT NULL,
    targetAgentId TEXT NOT NULL, taskId TEXT NOT NULL, generation INTEGER NOT NULL,
    sourceEventSeq INTEGER NOT NULL, promptDigest TEXT NOT NULL, scopeJson TEXT NOT NULL,
    ownerAuthUserId INTEGER NOT NULL, requesterMemberId TEXT NOT NULL,
    sourceDigest TEXT NOT NULL, agentOwnerMemberId TEXT NOT NULL,
    runId TEXT, terminalJson TEXT, publishedMessageId TEXT, publishedAt INTEGER,
    deliveryMode TEXT NOT NULL DEFAULT 'public' CHECK(deliveryMode IN ('public','private')),
    state TEXT NOT NULL CHECK(state IN
      ('reserved','admission_unknown','admitted','completed','failed')),
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_gc_hermes_hosted_task_generation
    ON gc_hermes_hosted_room_runs(taskId,generation);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_gc_hermes_hosted_run_id
    ON gc_hermes_hosted_room_runs(runId) WHERE runId IS NOT NULL;`)
  const columns = db.prepare('PRAGMA table_info(gc_hermes_hosted_room_runs)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'deliveryMode')) {
    db.exec("ALTER TABLE gc_hermes_hosted_room_runs ADD COLUMN deliveryMode TEXT NOT NULL DEFAULT 'public' CHECK(deliveryMode IN ('public','private'))")
  }
}

export function getHermesHostedRoomRun(db: DatabaseSync, queueId: string): HermesHostedRoomRun | null {
  const row = db.prepare('SELECT * FROM gc_hermes_hosted_room_runs WHERE queueId=?').get(queueId)
  return (row as unknown as HermesHostedRoomRun | undefined) || null
}

/** Idempotent only for an identical queue/source binding. Never clears an older intent. */
export function reserveHermesHostedRoomRun(
  db: DatabaseSync,
  input: Omit<HermesHostedRoomRun,
    'ownerAuthUserId' | 'requesterMemberId' | 'sourceDigest' | 'agentOwnerMemberId'
    | 'runId' | 'terminalJson' | 'publishedMessageId' | 'publishedAt' | 'deliveryMode' | 'state' | 'createdAt' | 'updatedAt'>,
  newSubmissionOnly = false,
  deliveryMode: 'public' | 'private' = 'public',
): HermesHostedRoomRun {
  if (![input.queueId, input.roomId, input.messageId, input.targetAgentId, input.taskId].every(value => identifier.test(value))
      || input.taskId !== input.queueId
      || !Number.isSafeInteger(input.generation) || input.generation <= 0
      || !Number.isSafeInteger(input.sourceEventSeq) || input.sourceEventSeq <= 0
      || !digest.test(input.promptDigest)
      || typeof input.scopeJson !== 'string' || input.scopeJson.length > 4096 || !input.scopeJson) {
    throw new Error('Invalid Hermes hosted-room reservation')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const queue = db.prepare('SELECT roomId,messageId,targetAgentId,requesterMemberId,sequence,status FROM gc_execution_queue WHERE id=?')
      .get(input.queueId) as Record<string, unknown> | undefined
    if (!queue || queue.roomId !== input.roomId || queue.messageId !== input.messageId
        || queue.targetAgentId !== input.targetAgentId || queue.sequence !== input.sourceEventSeq
        || queue.status !== 'running') throw new Error('Hermes hosted-room queue binding changed')
    const source = db.prepare('SELECT roomId,senderId,role,content FROM gc_messages WHERE id=?')
      .get(input.messageId) as Record<string, unknown> | undefined
    const agent = db.prepare('SELECT removedAt,ownerMemberId FROM gc_room_agents WHERE roomId=? AND agentId=?')
      .get(input.roomId, input.targetAgentId) as Record<string, unknown> | undefined
    const room = db.prepare('SELECT ownerAuthUserId FROM gc_rooms WHERE id=?')
      .get(input.roomId) as Record<string, unknown> | undefined
    const peer = source?.role === 'assistant'
      ? db.prepare('SELECT removedAt FROM gc_room_agents WHERE roomId=? AND agentId=?')
        .get(input.roomId, String(source.senderId || '')) as Record<string, unknown> | undefined
      : null
    if (source?.roomId !== input.roomId || source.senderId !== queue.requesterMemberId
        || (source.role !== 'user' && !(source.role === 'assistant' && peer?.removedAt === 0))
        || !agent || agent.removedAt !== 0) {
      throw new Error('Hermes hosted-room source or agent binding changed')
    }
    const ownerAuthUserId = Number(room?.ownerAuthUserId)
    if (!Number.isSafeInteger(ownerAuthUserId) || ownerAuthUserId <= 0 || typeof source.content !== 'string') {
      throw new Error('Hermes hosted-room owner or source is unavailable')
    }
    const requesterMemberId = String(queue.requesterMemberId)
    const sourceDigest = createHash('sha256').update(source.content).digest('hex')
    const agentOwnerMemberId = String(agent.ownerMemberId || '')
    let row = getHermesHostedRoomRun(db, input.queueId)
    if (row) {
      if (Object.entries(input).some(([key, value]) => row![key as keyof HermesHostedRoomRun] !== value)) {
        throw new Error('Hermes hosted-room reservation changed')
      }
      if (row.deliveryMode !== deliveryMode || row.ownerAuthUserId !== ownerAuthUserId || row.requesterMemberId !== requesterMemberId
          || row.sourceDigest !== sourceDigest || row.agentOwnerMemberId !== agentOwnerMemberId) {
        throw new Error('Hermes hosted-room authority changed')
      }
      if (newSubmissionOnly) throw new Error('Hermes hosted-room task already reserved; do not submit again')
    } else {
      const now = Date.now()
      db.prepare(`INSERT INTO gc_hermes_hosted_room_runs
        (queueId,roomId,messageId,targetAgentId,taskId,generation,sourceEventSeq,promptDigest,scopeJson,
         ownerAuthUserId,requesterMemberId,sourceDigest,agentOwnerMemberId,runId,terminalJson,
         publishedMessageId,publishedAt,deliveryMode,state,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,'reserved',?,?)`).run(
        input.queueId, input.roomId, input.messageId, input.targetAgentId, input.taskId,
        input.generation, input.sourceEventSeq, input.promptDigest, input.scopeJson,
        ownerAuthUserId, requesterMemberId, sourceDigest, agentOwnerMemberId, deliveryMode, now, now,
      )
      row = getHermesHostedRoomRun(db, input.queueId)
    }
    db.exec('COMMIT')
    return row!
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

/** A lost submission response stays ambiguous; no implicit second submission follows. */
export function markHermesAdmissionUnknown(db: DatabaseSync, queueId: string): void {
  db.prepare(`UPDATE gc_hermes_hosted_room_runs SET state='admission_unknown',updatedAt=?
    WHERE queueId=? AND state='reserved'`).run(Date.now(), queueId)
}

export function recordHermesRunAdmission(db: DatabaseSync, queueId: string, runId: string): HermesHostedRoomRun {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Invalid Hermes run ID')
  const result = db.prepare(`UPDATE gc_hermes_hosted_room_runs SET runId=?,state='admitted',updatedAt=?
    WHERE queueId=? AND state='reserved' AND runId IS NULL`).run(runId, Date.now(), queueId)
  const row = getHermesHostedRoomRun(db, queueId)
  if (!row || (result.changes !== 1 && (row.runId !== runId || row.state !== 'admitted'))) {
    throw new Error('Hermes hosted-room admission changed')
  }
  return row
}

export function recordHermesRunTerminal(
  db: DatabaseSync, queueId: string, runId: string, state: 'completed' | 'failed',
  terminal: Record<string, unknown>,
): HermesHostedRoomRun {
  if (terminal.object !== 'hermes.run' || terminal.run_id !== runId
      || (state === 'completed' && terminal.status !== 'completed')
      || (state === 'failed' && !['failed', 'cancelled', 'interrupted'].includes(String(terminal.status)))) {
    throw new Error('Hermes hosted-room terminal receipt does not match the run')
  }
  const terminalJson = JSON.stringify(terminal)
  if (terminalJson.length > 1_000_000) throw new Error('Hermes hosted-room terminal receipt is too large')
  const result = db.prepare(`UPDATE gc_hermes_hosted_room_runs SET state=?,terminalJson=?,updatedAt=?
    WHERE queueId=? AND runId=? AND state='admitted'`).run(state, terminalJson, Date.now(), queueId, runId)
  const row = getHermesHostedRoomRun(db, queueId)
  if (!row || (result.changes !== 1 && (row.runId !== runId || row.state !== state || row.terminalJson !== terminalJson))) {
    throw new Error('Hermes hosted-room terminal state changed')
  }
  return row
}
