import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getCloudflarePersonalRecoveryQuestion, recordRecoveredCloudflarePersonalResult,
  getCloudflarePersonalTurn, holdCloudflarePersonalUnknown, installCloudflarePersonalTurnJournal,
  markCloudflarePersonalDispatching, publishCloudflarePersonalRoomTurn,
  recordCloudflarePersonalResult, reserveCloudflarePersonalTurn,
} from '../../packages/server/src/modules/studio/services/group-chat/cloudflare-personal-turn-journal'

const sourceMessageId = 'owner-msg-1'
const idempotencyKey = 'f58e3c36-9076-4577-afbd-09073b9574ec'
const sourceCommit = '2a91274c93752f250d9bf7e486e0ddd2649d16d8'
const input = { sourceMessageId, roomId: 'room-1', requesterMemberId: 'auth:1',
  requesterAuthUserId: 1, idempotencyKey, visibility: 'private' as const }

const opened: DatabaseSync[] = []
afterEach(() => { while (opened.length) opened.pop()?.close() })
function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  opened.push(db)
  db.exec(`CREATE TABLE gc_rooms (id TEXT PRIMARY KEY, ownerAuthUserId INTEGER);
    CREATE TABLE gc_messages (id TEXT PRIMARY KEY, roomId TEXT, senderId TEXT, role TEXT, content TEXT);
    INSERT INTO gc_rooms VALUES ('room-1',1);
    INSERT INTO gc_messages VALUES ('owner-msg-1','room-1','auth:1','user','/cloud What is the status?');`)
  installCloudflarePersonalTurnJournal(db)
  return db
}

describe('Cloudflare Personal turn journal', () => {
  it('reserves the owner source before dispatch and saves one bound result', () => {
    const db = fixture()
    expect(reserveCloudflarePersonalTurn(db,input).state).toBe('reserved')
    expect(() => reserveCloudflarePersonalTurn(db,input)).toThrow('already reserved')
    markCloudflarePersonalDispatching(db,sourceMessageId)
    recordCloudflarePersonalResult(db,{
      sourceMessageId,idempotencyKey,answer:'Cloud answer',correlationId:'corr-1',
      sourceCommit,cloudflareVersionId:'version-1',
    })
    expect(getCloudflarePersonalTurn(db,sourceMessageId)).toMatchObject({ state:'ready',answer:'Cloud answer' })
    expect(() => markCloudflarePersonalDispatching(db,sourceMessageId)).toThrow('not reserved')
    expect(() => holdCloudflarePersonalUnknown(db,sourceMessageId)).toThrow('not dispatching')
  })

  it('holds an interrupted request without replay and rejects changed authority', () => {
    const db = fixture()
    reserveCloudflarePersonalTurn(db,input)
    db.prepare('UPDATE gc_rooms SET ownerAuthUserId=2 WHERE id=?').run('room-1')
    expect(() => markCloudflarePersonalDispatching(db,sourceMessageId)).toThrow('authority changed')
    db.prepare('UPDATE gc_rooms SET ownerAuthUserId=1 WHERE id=?').run('room-1')
    markCloudflarePersonalDispatching(db,sourceMessageId)
    holdCloudflarePersonalUnknown(db,sourceMessageId)
    expect(getCloudflarePersonalTurn(db,sourceMessageId)?.state).toBe('outcome_unknown')
    expect(() => recordCloudflarePersonalResult(db,{
      sourceMessageId,idempotencyKey,answer:'Late answer',correlationId:'corr-1',
      sourceCommit,cloudflareVersionId:'version-1',
    })).toThrow('not bound to a dispatch')
  })

  it('recovers only the unchanged owner question and original key', () => {
    const db = fixture()
    reserveCloudflarePersonalTurn(db,{ ...input, visibility: 'room' })
    markCloudflarePersonalDispatching(db,sourceMessageId)
    holdCloudflarePersonalUnknown(db,sourceMessageId)
    expect(getCloudflarePersonalRecoveryQuestion(db,sourceMessageId)).toBe('What is the status?')
    const result = { sourceMessageId,idempotencyKey,answer:'Recovered answer',
      correlationId:'corr-1',sourceCommit,cloudflareVersionId:'version-1' }
    expect(() => recordRecoveredCloudflarePersonalResult(db,{ ...result, idempotencyKey: crypto.randomUUID() })).toThrow()
    db.prepare('UPDATE gc_messages SET content=? WHERE id=?').run('/cloud Changed',sourceMessageId)
    expect(() => getCloudflarePersonalRecoveryQuestion(db,sourceMessageId)).toThrow('authority changed')
    db.prepare('UPDATE gc_messages SET content=? WHERE id=?').run('/cloud What is the status?',sourceMessageId)
    recordRecoveredCloudflarePersonalResult(db,result)
    expect(getCloudflarePersonalTurn(db,sourceMessageId)).toMatchObject({ state:'ready',answer:'Recovered answer' })
    expect(() => recordRecoveredCloudflarePersonalResult(db,result)).toThrow()
  })

  it('does not reserve a guest or a fabricated source', () => {
    const db = fixture()
    expect(() => reserveCloudflarePersonalTurn(db,{ ...input, requesterAuthUserId: 2 })).toThrow('owner source unavailable')
    db.prepare("UPDATE gc_messages SET role='assistant' WHERE id=?").run(sourceMessageId)
    expect(() => reserveCloudflarePersonalTurn(db,input)).toThrow('owner source unavailable')
  })

  it('holds a cloud answer if the owner changes the original room request', () => {
    const db = fixture()
    reserveCloudflarePersonalTurn(db,{ ...input, visibility: 'room' })
    markCloudflarePersonalDispatching(db,sourceMessageId)
    db.prepare('UPDATE gc_messages SET content=? WHERE id=?').run('/cloud Changed question',sourceMessageId)
    expect(() => recordCloudflarePersonalResult(db,{
      sourceMessageId,idempotencyKey,answer:'Original answer',correlationId:'corr-1',
      sourceCommit,cloudflareVersionId:'version-1',
    })).toThrow('authority changed')
    expect(getCloudflarePersonalTurn(db,sourceMessageId)?.state).toBe('dispatching')
  })

  it('publishes one external room answer atomically and will not replay it', () => {
    const db = fixture()
    reserveCloudflarePersonalTurn(db,{ ...input, visibility: 'room' })
    markCloudflarePersonalDispatching(db,sourceMessageId)
    recordCloudflarePersonalResult(db,{ sourceMessageId,idempotencyKey,answer:'Cloud answer',
      correlationId:'corr-1',sourceCommit,cloudflareVersionId:'version-1' })
    const persist = (message: { id: string; roomId: string; senderId: string; senderType: 'external'; content: string }) => {
      db.prepare('INSERT INTO gc_messages (id,roomId,senderId,role,content) VALUES (?,?,?,?,?)')
        .run(message.id,message.roomId,message.senderId,'assistant',message.content)
      expect(message.senderType).toBe('external')
      expect(message.content).toContain('Cloud answer')
    }
    const messageId = publishCloudflarePersonalRoomTurn(db,sourceMessageId,persist)
    expect(messageId).toMatch(/^gccloud_[a-f0-9]{64}$/)
    expect(getCloudflarePersonalTurn(db,sourceMessageId)?.state).toBe('published')
    expect(() => publishCloudflarePersonalRoomTurn(db,sourceMessageId,persist)).toThrow('not ready')
    expect((db.prepare('SELECT COUNT(*) AS n FROM gc_messages WHERE id=?').get(messageId) as { n: number }).n).toBe(1)
  })

  it('leaves a ready answer recoverable when publication fails', () => {
    const db = fixture()
    reserveCloudflarePersonalTurn(db,{ ...input, visibility: 'room' })
    markCloudflarePersonalDispatching(db,sourceMessageId)
    recordCloudflarePersonalResult(db,{ sourceMessageId,idempotencyKey,answer:'Cloud answer',
      correlationId:'corr-1',sourceCommit,cloudflareVersionId:'version-1' })
    expect(() => publishCloudflarePersonalRoomTurn(db,sourceMessageId,() => { throw new Error('storage failed') }))
      .toThrow('storage failed')
    expect(getCloudflarePersonalTurn(db,sourceMessageId)?.state).toBe('ready')
  })
})
