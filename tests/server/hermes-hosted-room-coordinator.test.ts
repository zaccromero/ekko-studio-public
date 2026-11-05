import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { HermesHostedRoomCoordinator } from '../../packages/server/src/modules/studio/services/group-chat/hermes-hosted-room-coordinator'
import { getHermesHostedRoomRun, installHermesHostedRoomLedger } from '../../packages/server/src/modules/studio/services/group-chat/hermes-hosted-room-ledger'
import { HermesRoomGrantClient } from '../../packages/server/src/modules/studio/services/group-chat/hermes-room-grant-client'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
})
const expiry = Math.floor(Date.now() / 1000) + 3600
const invitation = {
  object: 'hermes.room_member.invitation', grant: 'scoped-grant', target_profile: 'default',
  expires_at: expiry, status_expires_at: expiry + 3600,
  catalog: {
    installation_id: 'target_123', protocol_versions: [2], text: true,
    catalog_digest: 'a'.repeat(64),
    execution_policy: { version: 1, target_profile: 'default', enabled_toolsets: ['bot_room'], approval_mode: 'manual', policy_digest: 'b'.repeat(64) },
    endpoint: { available: true, url: 'https://hermes.example/private/', transport_security: 'tls' },
  },
}
const input = {
  identity: {
    room_id: 'room_123', home_install_id: 'home_123', authority_gateway_id: 'authority_123',
    authority_epoch: 1, member_id: 'member_123',
  },
  target: { installId: 'target_123', profile: 'default', origin: 'https://hermes.example' },
  queueId: 'queue_123', messageId: 'message_123', targetAgentId: 'agent_123',
  task: {
    taskId: 'queue_123', executionGeneration: 1, sourceEventSeq: 7,
    cancellationScopeId: 'cancel_123', prompt: 'Plan the next step', traceId: 'trace_123',
  },
  pollIntervalMs: 1,
}

function dbFixture() {
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
  return db
}

it('submits once after durable intent and stores a matching VM terminal receipt', async () => {
  const db = dbFixture()
  try {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(invitation, 201))
      .mockResolvedValueOnce(json({ run_id: 'run_123', status: 'queued' }, 202))
      .mockResolvedValueOnce(json({ object: 'hermes.run', run_id: 'run_123', status: 'completed', output: 'done' }))
    const grantClient = new HermesRoomGrantClient('https://hermes.example/private/', () => 'bootstrap', transport)
    const coordinator = new HermesHostedRoomCoordinator(db, grantClient, transport)
    expect((await coordinator.executeAndWait(input)).output).toBe('done')
    expect(getHermesHostedRoomRun(db, input.queueId)).toMatchObject({ state: 'completed', runId: 'run_123' })
    expect(transport).toHaveBeenCalledTimes(3)
    await expect(coordinator.executeAndWait(input)).rejects.toThrow('already reserved')
    expect(transport).toHaveBeenCalledTimes(3)
  } finally { db.close() }
})

it('pins private delivery before submitting an allone VM contribution', async () => {
  const db = dbFixture()
  try {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(invitation, 201))
      .mockResolvedValueOnce(json({ run_id: 'run_123', status: 'queued' }, 202))
      .mockResolvedValueOnce(json({ object: 'hermes.run', run_id: 'run_123', status: 'completed', output: 'private answer' }))
    const coordinator = new HermesHostedRoomCoordinator(db,
      new HermesRoomGrantClient('https://hermes.example/private/', () => 'bootstrap', transport), transport)
    expect((await coordinator.executeAndWait({ ...input, privateDelivery: true })).output).toBe('private answer')
    expect(getHermesHostedRoomRun(db, input.queueId)).toMatchObject({
      state: 'completed', deliveryMode: 'private', publishedMessageId: null,
    })
    await expect(coordinator.executeAndWait(input)).rejects.toThrow('already reserved')
    expect(transport).toHaveBeenCalledTimes(3)
  } finally { db.close() }
})

it('retains unknown admission and does not retry a lost submission', async () => {
  const db = dbFixture()
  try {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(invitation, 201))
      .mockRejectedValueOnce(new Error('connection lost after send'))
    const grantClient = new HermesRoomGrantClient('https://hermes.example/private/', () => 'bootstrap', transport)
    const coordinator = new HermesHostedRoomCoordinator(db, grantClient, transport)
    await expect(coordinator.executeAndWait(input)).rejects.toMatchObject({ name: 'HermesAdmissionUnknownError' })
    expect(getHermesHostedRoomRun(db, input.queueId)?.state).toBe('admission_unknown')
    expect(transport).toHaveBeenCalledTimes(2)
  } finally { db.close() }
})

it('resumes an admitted run by status only after the original readback is lost', async () => {
  const db = dbFixture()
  try {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(invitation, 201))
      .mockResolvedValueOnce(json({ run_id: 'run_123', status: 'queued' }, 202))
      .mockRejectedValueOnce(new Error('status connection lost'))
      .mockResolvedValueOnce(json(invitation, 201))
      .mockResolvedValueOnce(json({ object: 'hermes.run', run_id: 'run_123', status: 'completed', output: 'returned' }))
    const grantClient = new HermesRoomGrantClient('https://hermes.example/private/', () => 'bootstrap', transport)
    const coordinator = new HermesHostedRoomCoordinator(db, grantClient, transport)
    await expect(coordinator.executeAndWait(input)).rejects.toMatchObject({ name: 'HermesHostedRoomPendingError' })
    expect(getHermesHostedRoomRun(db, input.queueId)).toMatchObject({ state: 'admitted', runId: 'run_123' })
    expect((await coordinator.resumeKnownRun({ queueId: input.queueId, identity: input.identity, target: input.target })).output)
      .toBe('returned')
    expect(getHermesHostedRoomRun(db, input.queueId)?.state).toBe('completed')
    expect(transport.mock.calls.map(call => call[1]?.method)).toEqual(['POST', 'POST', 'GET', 'POST', 'GET'])
  } finally { db.close() }
})
