import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type CloudflarePersonalTurn = {
  sourceMessageId: string
  roomId: string
  requesterMemberId: string
  ownerAuthUserId: number
  sourceDigest: string
  idempotencyKey: string
  visibility: 'private' | 'room'
  state: 'reserved' | 'dispatching' | 'ready' | 'published' | 'outcome_unknown' | 'refused' | 'revoked'
  answer: string | null
  correlationId: string | null
  sourceCommit: string | null
  cloudflareVersionId: string | null
  createdAt: number
  updatedAt: number
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function installCloudflarePersonalTurnJournal(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS gc_cloud_personal_turns (
    sourceMessageId TEXT PRIMARY KEY, roomId TEXT NOT NULL, requesterMemberId TEXT NOT NULL,
    ownerAuthUserId INTEGER NOT NULL, sourceDigest TEXT NOT NULL, idempotencyKey TEXT NOT NULL UNIQUE,
    visibility TEXT NOT NULL CHECK(visibility IN ('private','room')),
    state TEXT NOT NULL CHECK(state IN ('reserved','dispatching','ready','published','outcome_unknown','refused','revoked')),
    answer TEXT, correlationId TEXT, sourceCommit TEXT, cloudflareVersionId TEXT,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gc_cloud_personal_turns_state ON gc_cloud_personal_turns(state,createdAt);`)
}

export function getCloudflarePersonalTurn(db: DatabaseSync, sourceMessageId: string): CloudflarePersonalTurn | null {
  return db.prepare('SELECT * FROM gc_cloud_personal_turns WHERE sourceMessageId=?')
    .get(sourceMessageId) as CloudflarePersonalTurn | undefined || null
}

function assertSource(db: DatabaseSync, row: CloudflarePersonalTurn): void {
  const room = db.prepare('SELECT ownerAuthUserId FROM gc_rooms WHERE id=?').get(row.roomId) as { ownerAuthUserId: number } | undefined
  const source = db.prepare('SELECT roomId,senderId,role,content FROM gc_messages WHERE id=?')
    .get(row.sourceMessageId) as { roomId: string; senderId: string; role: string; content: string } | undefined
  if (!room || Number(room.ownerAuthUserId) <= 0 || Number(room.ownerAuthUserId) !== row.ownerAuthUserId
      || source?.roomId !== row.roomId || source.senderId !== row.requesterMemberId
      || source.role !== 'user' || typeof source.content !== 'string'
      || hash(source.content) !== row.sourceDigest) {
    throw new Error('Personal cloud turn source authority changed')
  }
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try { const result = action(); db.exec('COMMIT'); return result }
  catch (error) { db.exec('ROLLBACK'); throw error }
}

/** Reserve the exact owner-authored source before any network request. */
export function reserveCloudflarePersonalTurn(db: DatabaseSync, input: {
  sourceMessageId: string; roomId: string; requesterMemberId: string
  requesterAuthUserId: number; idempotencyKey: string; visibility: 'private' | 'room'
}): CloudflarePersonalTurn {
  if (![input.sourceMessageId,input.roomId,input.requesterMemberId].every(value => identifier.test(value))
      || !Number.isSafeInteger(input.requesterAuthUserId) || input.requesterAuthUserId <= 0
      || !uuid.test(input.idempotencyKey) || !['private','room'].includes(input.visibility)) {
    throw new Error('Invalid Personal cloud turn reservation')
  }
  return transaction(db, () => {
    const room = db.prepare('SELECT ownerAuthUserId FROM gc_rooms WHERE id=?').get(input.roomId) as { ownerAuthUserId: number } | undefined
    const source = db.prepare('SELECT roomId,senderId,role,content FROM gc_messages WHERE id=?')
      .get(input.sourceMessageId) as { roomId: string; senderId: string; role: string; content: string } | undefined
    if (!room || Number(room.ownerAuthUserId) !== input.requesterAuthUserId || source?.roomId !== input.roomId
        || source.senderId !== input.requesterMemberId || source.role !== 'user'
        || typeof source.content !== 'string') throw new Error('Personal cloud turn owner source unavailable')
    const now = Date.now()
    const row: CloudflarePersonalTurn = {
      sourceMessageId: input.sourceMessageId, roomId: input.roomId, requesterMemberId: input.requesterMemberId,
      idempotencyKey: input.idempotencyKey, visibility: input.visibility,
      ownerAuthUserId: Number(room.ownerAuthUserId), sourceDigest: hash(source.content),
      state: 'reserved', answer: null, correlationId: null, sourceCommit: null,
      cloudflareVersionId: null, createdAt: now, updatedAt: now,
    }
    const existing = getCloudflarePersonalTurn(db, input.sourceMessageId)
    if (existing) throw new Error('Personal cloud turn source is already reserved')
    db.prepare(`INSERT INTO gc_cloud_personal_turns
      (sourceMessageId,roomId,requesterMemberId,ownerAuthUserId,sourceDigest,idempotencyKey,visibility,
       state,answer,correlationId,sourceCommit,cloudflareVersionId,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.sourceMessageId,row.roomId,row.requesterMemberId,row.ownerAuthUserId,row.sourceDigest,
      row.idempotencyKey,row.visibility,row.state,null,null,null,null,now,now,
    )
    return row
  })
}

/** A crash after this transition is outcome-unknown, even if no bytes left Ekko. */
export function markCloudflarePersonalDispatching(db: DatabaseSync, sourceMessageId: string): void {
  transaction(db, () => {
    const row = getCloudflarePersonalTurn(db, sourceMessageId)
    if (!row || row.state !== 'reserved') throw new Error('Personal cloud turn is not reserved')
    assertSource(db, row)
    db.prepare("UPDATE gc_cloud_personal_turns SET state='dispatching',updatedAt=? WHERE sourceMessageId=?")
      .run(Date.now(),sourceMessageId)
  })
}

export function recordCloudflarePersonalResult(db: DatabaseSync, input: {
  sourceMessageId: string; idempotencyKey: string; answer: string
  correlationId: string; sourceCommit: string; cloudflareVersionId: string
}): void {
  if (!input.answer || input.answer.length > 100_000
      || !input.correlationId || !input.cloudflareVersionId || !/^[a-f0-9]{40}$/.test(input.sourceCommit)) {
    throw new Error('Invalid Personal cloud result')
  }
  transaction(db, () => {
    const row = getCloudflarePersonalTurn(db, input.sourceMessageId)
    if (!row || row.state !== 'dispatching' || row.idempotencyKey !== input.idempotencyKey) {
      throw new Error('Personal cloud result is not bound to a dispatch')
    }
    assertSource(db, row)
    db.prepare(`UPDATE gc_cloud_personal_turns SET state='ready',answer=?,correlationId=?,
      sourceCommit=?,cloudflareVersionId=?,updatedAt=? WHERE sourceMessageId=?`).run(
      input.answer,input.correlationId,input.sourceCommit,input.cloudflareVersionId,Date.now(),input.sourceMessageId,
    )
  })
}

/** Never retry a dispatching turn after restart or an ambiguous transport failure. */
export function holdCloudflarePersonalUnknown(db: DatabaseSync, sourceMessageId: string): void {
  transaction(db, () => {
    const row = getCloudflarePersonalTurn(db, sourceMessageId)
    if (!row || row.state !== 'dispatching') throw new Error('Personal cloud turn is not dispatching')
    db.prepare("UPDATE gc_cloud_personal_turns SET state='outcome_unknown',updatedAt=? WHERE sourceMessageId=?")
      .run(Date.now(),sourceMessageId)
  })
}

export function refuseCloudflarePersonalTurn(db: DatabaseSync, sourceMessageId: string): void {
  transaction(db, () => {
    const row = getCloudflarePersonalTurn(db, sourceMessageId)
    if (!row || row.state !== 'dispatching') throw new Error('Personal cloud turn is not dispatching')
    db.prepare("UPDATE gc_cloud_personal_turns SET state='refused',updatedAt=? WHERE sourceMessageId=?")
      .run(Date.now(),sourceMessageId)
  })
}

/** Commit a sourced room message and the one-time journal transition together. */
export function publishCloudflarePersonalRoomTurn(db: DatabaseSync, sourceMessageId: string,
  persist: (message: { id: string; roomId: string; senderId: string; senderName: string;
    senderType: 'external'; role: 'assistant'; content: string; timestamp: number;
    mentions: []; run_id: null }) => void): string {
  return transaction(db, () => {
    const row = getCloudflarePersonalTurn(db, sourceMessageId)
    if (!row || row.state !== 'ready' || row.visibility !== 'room' || !row.answer
        || !row.correlationId || !row.sourceCommit || !row.cloudflareVersionId) {
      throw new Error('Personal cloud turn is not ready for room publication')
    }
    assertSource(db, row)
    const id = `gccloud_${hash(sourceMessageId)}`
    if (db.prepare('SELECT 1 FROM gc_messages WHERE id=?').get(id)) {
      throw new Error('Personal cloud publication message already exists')
    }
    persist({ id, roomId: row.roomId, senderId: 'cloudflare-personal',
      senderName: 'Cloudflare Personal · external result', senderType: 'external', role: 'assistant',
      content: `Cloudflare Personal answer (external system; source ${row.sourceCommit}; request ${row.sourceMessageId}; correlation ${row.correlationId}):\n\n${row.answer}`,
      timestamp: Date.now(), mentions: [], run_id: null })
    db.prepare("UPDATE gc_cloud_personal_turns SET state='published',updatedAt=? WHERE sourceMessageId=?")
      .run(Date.now(),sourceMessageId)
    return id
  })
}
