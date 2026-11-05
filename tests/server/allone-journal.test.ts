import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAllOneRecoveryAnswer, getAllOneJournal, installAllOneJournal, listAllOneContributions,
  markAllOnePublished, recordAllOneContribution, reserveAllOneJournal, setAllOneAnswer,
} from '../../packages/server/src/modules/studio/services/group-chat/allone-journal'

const dbs: DatabaseSync[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

function fixture(path = ':memory:') {
  const db = new DatabaseSync(path)
  dbs.push(db)
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE gc_rooms (id TEXT PRIMARY KEY, ownerAuthUserId INTEGER NOT NULL);
    CREATE TABLE gc_messages (id TEXT PRIMARY KEY,roomId TEXT,senderId TEXT,role TEXT,content TEXT);
    CREATE TABLE gc_room_agents (roomId TEXT,agentId TEXT,removedAt INTEGER,ownerMemberId TEXT,
      PRIMARY KEY(roomId,agentId));`)
  db.prepare('INSERT INTO gc_rooms VALUES (?,?)').run('room', 42)
  db.prepare('INSERT INTO gc_messages VALUES (?,?,?,?,?)').run('message','room','owner','user','@allone plan')
  // Existing Bridge rooms legitimately have blank ownerMemberId on local agents.
  db.prepare('INSERT INTO gc_room_agents VALUES (?,?,?,?)').run('room','codex',0,'')
  db.prepare('INSERT INTO gc_room_agents VALUES (?,?,?,?)').run('room','hermes',0,'')
  installAllOneJournal(db)
  const request = { messageId: 'message', roomId: 'room', requesterMemberId: 'owner',
    contributors: [{ agentId: 'codex', name: 'Codex' }, { agentId: 'hermes', name: 'Hermes' }] }
  return { db, request }
}

describe('durable @allone journal authority', () => {
  it('reserves one owner-authored message and refuses duplicate model invocation', () => {
    const { db, request } = fixture()
    const row = reserveAllOneJournal(db, request)
    expect(row.state).toBe('collecting')
    expect(getAllOneJournal(db, 'message')?.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(() => reserveAllOneJournal(db, request)).toThrow('already reserved')
    expect(() => reserveAllOneJournal(db, { ...request, requesterMemberId: 'guest' }))
      .toThrow('source authority unavailable')
  })

  it('persists one private contribution and holds changed or foreign results', () => {
    const { db, request } = fixture()
    reserveAllOneJournal(db, request)
    const result = { messageId: 'message', agentId: 'hermes', agentName: 'Hermes',
      text: 'VM result', error: null, finishedAt: 100 }
    recordAllOneContribution(db, result)
    recordAllOneContribution(db, result)
    expect(listAllOneContributions(db, 'message')).toMatchObject([result])
    expect(() => recordAllOneContribution(db, { ...result, text: 'replacement' })).toThrow('changed after completion')
    expect(() => recordAllOneContribution(db, { ...result, agentId: 'other' })).toThrow('not reserved')
  })

  it('holds capture when the source, room owner, or agent authority changes', () => {
    for (const change of [
      (db: DatabaseSync) => db.prepare('UPDATE gc_messages SET content=? WHERE id=?').run('edited','message'),
      (db: DatabaseSync) => db.prepare('UPDATE gc_rooms SET ownerAuthUserId=? WHERE id=?').run(43,'room'),
      (db: DatabaseSync) => db.prepare('UPDATE gc_room_agents SET removedAt=? WHERE agentId=?').run(1,'hermes'),
      (db: DatabaseSync) => db.prepare('UPDATE gc_room_agents SET ownerMemberId=? WHERE agentId=?').run('new-owner','hermes'),
    ]) {
      const { db, request } = fixture()
      reserveAllOneJournal(db, request)
      change(db)
      expect(() => recordAllOneContribution(db, { messageId: 'message', agentId: 'codex',
        agentName: 'Codex', text: 'answer', error: null, finishedAt: 100 })).toThrow('authority changed')
      expect(() => listAllOneContributions(db, 'message')).toThrow('authority changed')
    }
  })

  it('requires the exact saved single answer before marking publication', () => {
    const { db, request } = fixture()
    reserveAllOneJournal(db, request)
    setAllOneAnswer(db, { messageId: 'message', posterAgentId: 'codex',
      content: 'one answer', publishedMessageId: 'gcallone_123' })
    expect(() => markAllOnePublished(db, 'message')).toThrow('absent or changed')
    db.prepare('INSERT INTO gc_messages VALUES (?,?,?,?,?)')
      .run('gcallone_123','room','codex','assistant','wrong answer')
    expect(() => markAllOnePublished(db, 'message')).toThrow('absent or changed')
    db.prepare('UPDATE gc_messages SET content=? WHERE id=?').run('one answer','gcallone_123')
    expect(markAllOnePublished(db, 'message')).toBe(true)
    expect(markAllOnePublished(db, 'message')).toBe(false)
    expect(getAllOneJournal(db, 'message')?.state).toBe('published')
  })

  it('recovers saved private text from a reopened database without replaying a model', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ekko-allone-journal-'))
    try {
      const { db, request } = fixture(join(directory, 'room.db'))
      reserveAllOneJournal(db, request)
      recordAllOneContribution(db, { messageId: 'message', agentId: 'hermes', agentName: 'Hermes',
        text: 'VM reply survived', error: null, finishedAt: 100 })
      db.close()
      dbs.splice(dbs.indexOf(db), 1)

      const reopened = new DatabaseSync(join(directory, 'room.db'))
      dbs.push(reopened)
      const row = getAllOneJournal(reopened, 'message')!
      const answer = buildAllOneRecoveryAnswer(reopened, row)
      expect(answer).toContain('VM reply survived')
      expect(answer).toContain('Codex')
      expect(answer).toContain('no request was replayed')
      setAllOneAnswer(reopened, { messageId: 'message', posterAgentId: 'codex',
        content: answer, publishedMessageId: 'gcallone_recovered' })
      reopened.prepare('INSERT INTO gc_messages VALUES (?,?,?,?,?)')
        .run('gcallone_recovered','room','codex','assistant',answer)
      expect(markAllOnePublished(reopened, 'message')).toBe(true)
      expect(markAllOnePublished(reopened, 'message')).toBe(false)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
