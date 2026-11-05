import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import {
  getHermesHostedRoomRun, installHermesHostedRoomLedger, markHermesAdmissionUnknown,
  recordHermesRunAdmission, recordHermesRunTerminal, reserveHermesHostedRoomRun,
} from '../../packages/server/src/modules/studio/services/group-chat/hermes-hosted-room-ledger'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE gc_execution_queue (
    id TEXT PRIMARY KEY, roomId TEXT, messageId TEXT, targetAgentId TEXT,
    requesterMemberId TEXT, sequence INTEGER, status TEXT
  );
  CREATE TABLE gc_messages (id TEXT PRIMARY KEY, roomId TEXT, senderId TEXT, role TEXT, content TEXT);
  CREATE TABLE gc_room_agents (roomId TEXT, agentId TEXT, removedAt INTEGER, ownerMemberId TEXT);
  CREATE TABLE gc_rooms (id TEXT PRIMARY KEY, ownerAuthUserId INTEGER);`)
  db.prepare(`INSERT INTO gc_execution_queue VALUES (?,?,?,?,?,?,?)`).run(
    'queue_123', 'room_123', 'message_123', 'agent_123', 'auth:1', 7, 'running',
  )
  db.prepare(`INSERT INTO gc_messages VALUES (?,?,?,?,?)`).run('message_123', 'room_123', 'auth:1', 'user', 'Plan this')
  db.prepare(`INSERT INTO gc_room_agents VALUES (?,?,?,?)`).run('room_123', 'agent_123', 0, '')
  db.prepare(`INSERT INTO gc_rooms VALUES (?,?)`).run('room_123', 1)
  installHermesHostedRoomLedger(db)
  const input = {
    queueId: 'queue_123', roomId: 'room_123', messageId: 'message_123', targetAgentId: 'agent_123',
    taskId: 'queue_123', generation: 1, sourceEventSeq: 7, promptDigest: 'a'.repeat(64), scopeJson: '{}',
  }
  return { db, input }
}

it('persists one queue-bound VM intent, admission and terminal state', () => {
  const { db, input } = fixture()
  try {
    expect(reserveHermesHostedRoomRun(db, input).state).toBe('reserved')
    expect(() => reserveHermesHostedRoomRun(db, input, true)).toThrow('already reserved')
    expect(reserveHermesHostedRoomRun(db, input).state).toBe('reserved')
    expect(() => reserveHermesHostedRoomRun(db, { ...input, promptDigest: 'b'.repeat(64) }))
      .toThrow('reservation changed')
    expect(recordHermesRunAdmission(db, input.queueId, 'run_123').state).toBe('admitted')
    const terminal = { object: 'hermes.run', run_id: 'run_123', status: 'completed', output: 'done' }
    expect(recordHermesRunTerminal(db, input.queueId, 'run_123', 'completed', terminal).state).toBe('completed')
    expect(getHermesHostedRoomRun(db, input.queueId)?.runId).toBe('run_123')
    expect(JSON.parse(getHermesHostedRoomRun(db, input.queueId)!.terminalJson!)).toEqual(terminal)
    expect(() => recordHermesRunTerminal(db, input.queueId, 'run_other', 'failed', { ...terminal, run_id: 'run_other', status: 'failed' }))
      .toThrow('terminal state changed')
  } finally { db.close() }
})

it('adds public delivery mode to an existing hosted-run table without changing old rows', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE gc_hermes_hosted_room_runs (
      queueId TEXT PRIMARY KEY, roomId TEXT, messageId TEXT, targetAgentId TEXT,
      taskId TEXT, generation INTEGER, sourceEventSeq INTEGER, promptDigest TEXT,
      scopeJson TEXT, ownerAuthUserId INTEGER, requesterMemberId TEXT, sourceDigest TEXT,
      agentOwnerMemberId TEXT, runId TEXT, terminalJson TEXT, publishedMessageId TEXT,
      publishedAt INTEGER, state TEXT, createdAt INTEGER, updatedAt INTEGER
    );`)
    db.prepare(`INSERT INTO gc_hermes_hosted_room_runs (queueId,state) VALUES ('old_run','completed')`).run()
    installHermesHostedRoomLedger(db)
    expect(db.prepare(`SELECT deliveryMode,state FROM gc_hermes_hosted_room_runs WHERE queueId='old_run'`).get())
      .toMatchObject({ deliveryMode: 'public', state: 'completed' })
    installHermesHostedRoomLedger(db)
  } finally { db.close() }
})

it('keeps ambiguous admission and changed queue bindings from becoming a second run', () => {
  const { db, input } = fixture()
  try {
    db.prepare(`UPDATE gc_execution_queue SET targetAgentId='other' WHERE id=?`).run(input.queueId)
    expect(() => reserveHermesHostedRoomRun(db, input)).toThrow('queue binding changed')
    db.prepare(`UPDATE gc_execution_queue SET targetAgentId=? WHERE id=?`).run(input.targetAgentId, input.queueId)
    db.prepare(`UPDATE gc_room_agents SET removedAt=1 WHERE roomId=? AND agentId=?`).run(input.roomId, input.targetAgentId)
    expect(() => reserveHermesHostedRoomRun(db, input)).toThrow('source or agent binding changed')
    db.prepare(`UPDATE gc_room_agents SET removedAt=0 WHERE roomId=? AND agentId=?`).run(input.roomId, input.targetAgentId)
    reserveHermesHostedRoomRun(db, input)
    markHermesAdmissionUnknown(db, input.queueId)
    expect(getHermesHostedRoomRun(db, input.queueId)?.state).toBe('admission_unknown')
    expect(() => recordHermesRunAdmission(db, input.queueId, 'run_123'))
      .toThrow('admission changed')
  } finally { db.close() }
})

it('accepts an active peer Agent as a room source and rejects a removed peer', () => {
  const { db, input } = fixture()
  try {
    db.prepare(`INSERT INTO gc_room_agents VALUES (?,?,?,?)`).run('room_123', 'peer_123', 0, '')
    db.prepare(`UPDATE gc_messages SET senderId='peer_123',role='assistant' WHERE id=?`).run(input.messageId)
    db.prepare(`UPDATE gc_execution_queue SET requesterMemberId='peer_123' WHERE id=?`).run(input.queueId)
    expect(reserveHermesHostedRoomRun(db, input).state).toBe('reserved')
    db.prepare(`UPDATE gc_room_agents SET removedAt=1 WHERE agentId='peer_123'`).run()
    expect(() => reserveHermesHostedRoomRun(db, input)).toThrow('source or agent binding changed')
  } finally { db.close() }
})
