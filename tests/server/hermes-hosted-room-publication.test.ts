import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import {
  installHermesHostedRoomLedger, recordHermesRunAdmission, recordHermesRunTerminal,
  reserveHermesHostedRoomRun,
} from '../../packages/server/src/modules/studio/services/group-chat/hermes-hosted-room-ledger'
import { publishHermesHostedRoomResult } from '../../packages/server/src/modules/studio/services/group-chat/hermes-hosted-room-publication'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE gc_execution_queue (
    id TEXT PRIMARY KEY, roomId TEXT, messageId TEXT, targetAgentId TEXT,
    requesterMemberId TEXT, sequence INTEGER, status TEXT, finishedAt INTEGER, lastError TEXT
  );
  CREATE TABLE gc_messages (
    id TEXT PRIMARY KEY, roomId TEXT, senderId TEXT, role TEXT, content TEXT, run_id TEXT
  );
  CREATE TABLE gc_room_agents (roomId TEXT, agentId TEXT, name TEXT, removedAt INTEGER, ownerMemberId TEXT);
  CREATE TABLE gc_rooms (id TEXT PRIMARY KEY, ownerAuthUserId INTEGER);`)
  db.prepare(`INSERT INTO gc_execution_queue VALUES (?,?,?,?,?,?,?,NULL,NULL)`).run(
    'queue_123', 'room_123', 'message_123', 'agent_123', 'auth:1', 7, 'running',
  )
  db.prepare(`INSERT INTO gc_messages VALUES (?,?,?,?,?,NULL)`).run(
    'message_123', 'room_123', 'auth:1', 'user', 'Plan this',
  )
  db.prepare(`INSERT INTO gc_room_agents VALUES (?,?,?,?,?)`).run('room_123', 'agent_123', 'Hermes', 0, '')
  db.prepare(`INSERT INTO gc_rooms VALUES (?,?)`).run('room_123', 1)
  installHermesHostedRoomLedger(db)
  reserveHermesHostedRoomRun(db, {
    queueId: 'queue_123', roomId: 'room_123', messageId: 'message_123', targetAgentId: 'agent_123',
    taskId: 'queue_123', generation: 1, sourceEventSeq: 7,
    promptDigest: 'a'.repeat(64), scopeJson: '{}',
  })
  recordHermesRunAdmission(db, 'queue_123', 'run_123')
  recordHermesRunTerminal(db, 'queue_123', 'run_123', 'completed', {
    object: 'hermes.run', run_id: 'run_123', status: 'completed', output: 'A concrete plan',
  })
  const persist = vi.fn((message: { id: string; roomId: string; senderId: string; role: string; content: string; run_id: string }) => {
    db.prepare(`INSERT INTO gc_messages VALUES (?,?,?,?,?,?)`).run(
      message.id, message.roomId, message.senderId, message.role, message.content, message.run_id,
    )
  })
  const notify = vi.fn()
  return { db, persist, notify }
}

it('publishes one verified VM reply and retains its marker across repeated readback', () => {
  const { db, persist, notify } = fixture()
  try {
    const options = { db, queueId: 'queue_123', persist, notify }
    expect(publishHermesHostedRoomResult(options)).toBe('published')
    expect(publishHermesHostedRoomResult(options)).toBe('already_published')
    expect(persist).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(db.prepare(`SELECT status FROM gc_execution_queue WHERE id='queue_123'`).get()).toMatchObject({ status: 'completed' })
    const row = db.prepare(`SELECT content,senderId FROM gc_messages WHERE id LIKE 'gcvm_%'`).get() as any
    expect(row).toMatchObject({ content: 'A concrete plan', senderId: 'agent_123' })
  } finally { db.close() }
})

it('publishes the saved canonical reply after the room queue recorded a parser failure', () => {
  const { db, persist, notify } = fixture()
  try {
    db.prepare(`UPDATE gc_execution_queue SET status='failed',lastError='Missing optional completed flag' WHERE id='queue_123'`).run()
    expect(publishHermesHostedRoomResult({ db, queueId: 'queue_123', persist, notify })).toBe('published')
    expect(db.prepare(`SELECT status,lastError FROM gc_execution_queue WHERE id='queue_123'`).get())
      .toMatchObject({ status: 'completed', lastError: null })
    expect(persist).toHaveBeenCalledTimes(1)
  } finally { db.close() }
})

it('refuses a result after room ownership or source content changes', () => {
  const { db, persist, notify } = fixture()
  try {
    db.prepare(`UPDATE gc_rooms SET ownerAuthUserId=2 WHERE id='room_123'`).run()
    expect(() => publishHermesHostedRoomResult({ db, queueId: 'queue_123', persist, notify }))
      .toThrow('publication authority changed')
    db.prepare(`UPDATE gc_rooms SET ownerAuthUserId=1 WHERE id='room_123'`).run()
    db.prepare(`UPDATE gc_messages SET content='Changed request' WHERE id='message_123'`).run()
    expect(() => publishHermesHostedRoomResult({ db, queueId: 'queue_123', persist, notify }))
      .toThrow('publication authority changed')
    expect(persist).not.toHaveBeenCalled()
  } finally { db.close() }
})

it('repairs the restart-failed queue card only when the saved VM reply publishes', () => {
  const { db, persist, notify } = fixture()
  try {
    db.prepare(`UPDATE gc_execution_queue SET status='failed',lastError='Studio restarted' WHERE id='queue_123'`).run()
    expect(publishHermesHostedRoomResult({ db, queueId: 'queue_123', persist, notify })).toBe('published')
    expect(db.prepare(`SELECT status,lastError,finishedAt FROM gc_execution_queue WHERE id='queue_123'`).get())
      .toMatchObject({ status: 'completed', lastError: null, finishedAt: expect.any(Number) })
  } finally { db.close() }
})
