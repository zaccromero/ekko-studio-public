import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { neutralizeMentions } from './mention-routing'

type Contributor = { agentId: string; name: string; ownerMemberId: string }

export type AllOneJournal = {
  messageId: string
  roomId: string
  requesterMemberId: string
  ownerAuthUserId: number
  sourceDigest: string
  contributorsJson: string
  state: 'collecting' | 'ready' | 'published' | 'revoked'
  answer: string | null
  posterAgentId: string | null
  publishedMessageId: string | null
  createdAt: number
  updatedAt: number
}

export type AllOneJournalContribution = {
  messageId: string
  agentId: string
  agentName: string
  text: string
  error: string | null
  finishedAt: number
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/
const ownerMemberBinding = (value: unknown): value is string =>
  typeof value === 'string' && (value === '' || identifier.test(value))
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export function installAllOneJournal(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS gc_allone_journal (
    messageId TEXT PRIMARY KEY, roomId TEXT NOT NULL, requesterMemberId TEXT NOT NULL,
    ownerAuthUserId INTEGER NOT NULL, sourceDigest TEXT NOT NULL,
    contributorsJson TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('collecting','ready','published','revoked')),
    answer TEXT, posterAgentId TEXT, publishedMessageId TEXT,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gc_allone_journal_room_state
    ON gc_allone_journal(roomId,state,createdAt);
  CREATE TABLE IF NOT EXISTS gc_allone_contributions (
    messageId TEXT NOT NULL, agentId TEXT NOT NULL, agentName TEXT NOT NULL,
    text TEXT NOT NULL, error TEXT, finishedAt INTEGER NOT NULL,
    PRIMARY KEY(messageId,agentId),
    FOREIGN KEY(messageId) REFERENCES gc_allone_journal(messageId) ON DELETE CASCADE
  );`)
}

function sourceBinding(db: DatabaseSync, row: AllOneJournal): boolean {
  const room = db.prepare('SELECT ownerAuthUserId FROM gc_rooms WHERE id=?').get(row.roomId) as { ownerAuthUserId: number } | undefined
  const source = db.prepare('SELECT roomId,senderId,role,content FROM gc_messages WHERE id=?')
    .get(row.messageId) as { roomId: string; senderId: string; role: string; content: string } | undefined
  return Number(room?.ownerAuthUserId) === row.ownerAuthUserId && row.ownerAuthUserId > 0
    && source?.roomId === row.roomId && source.senderId === row.requesterMemberId
    && source.role === 'user' && typeof source.content === 'string'
    && hash(source.content) === row.sourceDigest
}

function contributorsBound(db: DatabaseSync, row: AllOneJournal): boolean {
  let contributors: Contributor[]
  try { contributors = JSON.parse(row.contributorsJson) as Contributor[] }
  catch { return false }
  if (!Array.isArray(contributors) || contributors.length === 0 || contributors.length > 32) return false
  const seen = new Set<string>()
  for (const contributor of contributors) {
    if (!identifier.test(contributor.agentId) || !contributor.name || !ownerMemberBinding(contributor.ownerMemberId)
        || seen.has(contributor.agentId)) return false
    seen.add(contributor.agentId)
    const agent = db.prepare('SELECT removedAt,ownerMemberId FROM gc_room_agents WHERE roomId=? AND agentId=?')
      .get(row.roomId, contributor.agentId) as { removedAt: number; ownerMemberId: string } | undefined
    if (!agent || agent.removedAt !== 0 || String(agent.ownerMemberId || '') !== contributor.ownerMemberId) return false
  }
  return true
}

export function getAllOneJournal(db: DatabaseSync, messageId: string): AllOneJournal | null {
  return db.prepare('SELECT * FROM gc_allone_journal WHERE messageId=?').get(messageId) as AllOneJournal | undefined || null
}

export function assertAllOneJournalAuthority(db: DatabaseSync, row: AllOneJournal): void {
  if (!sourceBinding(db, row) || !contributorsBound(db, row)) throw new Error('@allone journal authority changed')
}

/** Reserve the exact owner-authored room message before any private model invocation. */
export function reserveAllOneJournal(db: DatabaseSync, input: {
  messageId: string; roomId: string; requesterMemberId: string
  contributors: Array<{ agentId: string; name: string }>
}): AllOneJournal {
  if (![input.messageId, input.roomId, input.requesterMemberId].every(value => identifier.test(value))
      || !Array.isArray(input.contributors) || input.contributors.length === 0 || input.contributors.length > 32) {
    throw new Error('Invalid @allone journal reservation')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const room = db.prepare('SELECT ownerAuthUserId FROM gc_rooms WHERE id=?').get(input.roomId) as { ownerAuthUserId: number } | undefined
    const source = db.prepare('SELECT roomId,senderId,role,content FROM gc_messages WHERE id=?')
      .get(input.messageId) as { roomId: string; senderId: string; role: string; content: string } | undefined
    if (!room || Number(room.ownerAuthUserId) <= 0 || source?.roomId !== input.roomId
        || source.senderId !== input.requesterMemberId || source.role !== 'user'
        || typeof source.content !== 'string') throw new Error('@allone source authority unavailable')
    const contributors: Contributor[] = input.contributors.map(({ agentId, name }) => {
      if (!identifier.test(agentId) || typeof name !== 'string' || !name || name.length > 160) {
        throw new Error('Invalid @allone contributor')
      }
      const agent = db.prepare('SELECT removedAt,ownerMemberId FROM gc_room_agents WHERE roomId=? AND agentId=?')
        .get(input.roomId, agentId) as { removedAt: number; ownerMemberId: string } | undefined
      if (!agent || agent.removedAt !== 0 || !ownerMemberBinding(agent.ownerMemberId)) {
        throw new Error('@allone contributor authority unavailable')
      }
      return { agentId, name, ownerMemberId: agent.ownerMemberId }
    })
    if (new Set(contributors.map(c => c.agentId)).size !== contributors.length) throw new Error('Duplicate @allone contributor')
    const now = Date.now()
    const row: AllOneJournal = {
      messageId: input.messageId, roomId: input.roomId, requesterMemberId: input.requesterMemberId,
      ownerAuthUserId: Number(room.ownerAuthUserId), sourceDigest: hash(source.content),
      contributorsJson: JSON.stringify(contributors), state: 'collecting',
      answer: null, posterAgentId: null, publishedMessageId: null, createdAt: now, updatedAt: now,
    }
    const existing = getAllOneJournal(db, input.messageId)
    if (existing) {
      if (existing.roomId !== row.roomId || existing.requesterMemberId !== row.requesterMemberId
          || existing.ownerAuthUserId !== row.ownerAuthUserId || existing.sourceDigest !== row.sourceDigest
          || existing.contributorsJson !== row.contributorsJson) throw new Error('@allone journal binding changed')
      throw new Error('@allone message already reserved; do not invoke again')
    }
    db.prepare(`INSERT INTO gc_allone_journal
      (messageId,roomId,requesterMemberId,ownerAuthUserId,sourceDigest,contributorsJson,state,answer,posterAgentId,publishedMessageId,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,'collecting',NULL,NULL,NULL,?,?)`)
      .run(row.messageId,row.roomId,row.requesterMemberId,row.ownerAuthUserId,row.sourceDigest,row.contributorsJson,now,now)
    db.exec('COMMIT')
    return row
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

/** One terminal private contribution. Identical repeat reads are safe; changed text is held. */
function recordContributionInTransaction(db: DatabaseSync, input: AllOneJournalContribution): void {
  if (!identifier.test(input.messageId) || !identifier.test(input.agentId)
      || typeof input.agentName !== 'string' || !input.agentName || input.agentName.length > 160
      || typeof input.text !== 'string' || input.text.length > 512_000
      || (input.error !== null && (typeof input.error !== 'string' || input.error.length > 2000))
      || !Number.isSafeInteger(input.finishedAt) || input.finishedAt <= 0) {
    throw new Error('Invalid @allone contribution')
  }
    const row = getAllOneJournal(db, input.messageId)
    if (!row || row.state !== 'collecting' || !sourceBinding(db, row) || !contributorsBound(db, row)) {
      throw new Error('@allone journal authority changed')
    }
    const contributors = JSON.parse(row.contributorsJson) as Contributor[]
    if (!contributors.some(c => c.agentId === input.agentId && c.name === input.agentName)) {
      throw new Error('@allone contributor is not reserved')
    }
    const existing = db.prepare('SELECT * FROM gc_allone_contributions WHERE messageId=? AND agentId=?')
      .get(input.messageId, input.agentId) as AllOneJournalContribution | undefined
    if (existing) {
      if (existing.agentName !== input.agentName || existing.text !== input.text || existing.error !== input.error) {
        throw new Error('@allone contribution changed after completion')
      }
    } else {
      db.prepare(`INSERT INTO gc_allone_contributions (messageId,agentId,agentName,text,error,finishedAt)
        VALUES (?,?,?,?,?,?)`).run(input.messageId,input.agentId,input.agentName,input.text,input.error,input.finishedAt)
    }
}

/** Use only while the caller holds a write transaction, such as VM terminal consumption. */
export function recordAllOneContributionInTransaction(db: DatabaseSync, input: AllOneJournalContribution): void {
  recordContributionInTransaction(db, input)
}

export function recordAllOneContribution(db: DatabaseSync, input: AllOneJournalContribution): void {
  db.exec('BEGIN IMMEDIATE')
  try { recordContributionInTransaction(db, input); db.exec('COMMIT') }
  catch (error) { db.exec('ROLLBACK'); throw error }
}

export function listAllOneContributions(db: DatabaseSync, messageId: string): AllOneJournalContribution[] {
  const row = getAllOneJournal(db, messageId)
  if (!row || !sourceBinding(db, row) || !contributorsBound(db, row)) throw new Error('@allone journal authority changed')
  return db.prepare('SELECT * FROM gc_allone_contributions WHERE messageId=? ORDER BY finishedAt,agentId')
    .all(messageId) as AllOneJournalContribution[]
}

export function setAllOneAnswer(db: DatabaseSync, input: {
  messageId: string; posterAgentId: string; content: string; publishedMessageId: string
}): void {
  if (!identifier.test(input.messageId) || !identifier.test(input.posterAgentId)
      || !identifier.test(input.publishedMessageId)
      || typeof input.content !== 'string' || !input.content || input.content.length > 512_000) {
    throw new Error('Invalid @allone answer')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = getAllOneJournal(db, input.messageId)
    if (!row || row.state !== 'collecting') throw new Error('@allone journal is not collecting')
    assertAllOneJournalAuthority(db, row)
    const contributors = JSON.parse(row.contributorsJson) as Contributor[]
    if (!contributors.some(c => c.agentId === input.posterAgentId)) throw new Error('@allone poster is not reserved')
    const changed = db.prepare(`UPDATE gc_allone_journal
      SET state='ready',answer=?,posterAgentId=?,publishedMessageId=?,updatedAt=?
      WHERE messageId=? AND state='collecting'`).run(
      input.content,input.posterAgentId,input.publishedMessageId,Date.now(),input.messageId,
    )
    if (changed.changes !== 1) throw new Error('@allone journal answer changed')
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

/** A saved reply is the only proof of publication; an ACK alone is insufficient. */
export function markAllOnePublished(db: DatabaseSync, messageId: string): boolean {
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = getAllOneJournal(db, messageId)
    if (!row || !['ready','published'].includes(row.state) || !row.answer
        || !row.posterAgentId || !row.publishedMessageId) throw new Error('@allone answer is not ready')
    assertAllOneJournalAuthority(db, row)
    const saved = db.prepare('SELECT roomId,senderId,role,content FROM gc_messages WHERE id=?')
      .get(row.publishedMessageId) as { roomId: string; senderId: string; role: string; content: string } | undefined
    if (!saved || saved.roomId !== row.roomId || saved.senderId !== row.posterAgentId
        || saved.role !== 'assistant' || saved.content !== row.answer) {
      throw new Error('@allone published message is absent or changed')
    }
    if (row.state === 'published') { db.exec('COMMIT'); return false }
    const updated = db.prepare("UPDATE gc_allone_journal SET state='published',updatedAt=? WHERE messageId=? AND state='ready'")
      .run(Date.now(),messageId)
    if (updated.changes !== 1) throw new Error('@allone publication marker changed')
    db.exec('COMMIT')
    return true
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

export function listUnfinishedAllOneJournal(db: DatabaseSync, limit = 25): AllOneJournal[] {
  return db.prepare("SELECT * FROM gc_allone_journal WHERE state IN ('collecting','ready') ORDER BY createdAt LIMIT ?")
    .all(limit) as AllOneJournal[]
}

/** A restart never submits another model request; missing private output stays explicit. */
export function buildAllOneRecoveryAnswer(db: DatabaseSync, row: AllOneJournal): string {
  assertAllOneJournalAuthority(db, row)
  const contributors = JSON.parse(row.contributorsJson) as Contributor[]
  const saved = new Map(listAllOneContributions(db, row.messageId).map(c => [c.agentId, c]))
  const sections = contributors.map(contributor => {
    const result = saved.get(contributor.agentId)
    const label = `**${contributor.name}**`
    if (!result) return `${label} — result unavailable after Studio restart; no request was replayed.`
    if (result.error || !result.text.trim()) return `${label} — ${result.error || 'empty reply'}`
    return `${label}\n${result.text.slice(0, 12_000)}`
  })
  return neutralizeMentions([
    '**Team answer recovered after Studio restarted.** Private contributions are shown separately. Missing results were not replayed.',
    ...sections,
  ].join('\n\n'))
}
