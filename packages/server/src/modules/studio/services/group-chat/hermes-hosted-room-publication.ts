import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getHermesHostedRoomRun } from './hermes-hosted-room-ledger'
import { hasHermesCompleteTextReply } from './hermes-run-api-client'

export type HostedRoomMessage = {
  id: string
  roomId: string
  senderId: string
  senderName: string
  senderType: 'agent'
  role: 'assistant'
  content: string
  timestamp: number
  run_id: string
  mentions: []
}

/** Consume a private @allone VM result without publishing it into room history. */
export function consumeHermesHostedPrivateResult(db: DatabaseSync, queueId: string): string {
  db.exec('BEGIN IMMEDIATE')
  try {
    const run = getHermesHostedRoomRun(db, queueId)
    if (!run || run.deliveryMode !== 'private' || run.state !== 'completed' || !run.runId
        || !run.terminalJson || run.publishedAt !== null || run.publishedMessageId !== null) {
      throw new Error('Hermes private result is not available for capture')
    }
    const room = db.prepare('SELECT ownerAuthUserId FROM gc_rooms WHERE id=?').get(run.roomId) as Record<string, unknown> | undefined
    const queue = db.prepare(`SELECT roomId,messageId,targetAgentId,requesterMemberId,sequence,status
      FROM gc_execution_queue WHERE id=?`).get(queueId) as Record<string, unknown> | undefined
    const source = db.prepare('SELECT roomId,senderId,role,content FROM gc_messages WHERE id=?')
      .get(run.messageId) as Record<string, unknown> | undefined
    const agent = db.prepare('SELECT removedAt,ownerMemberId FROM gc_room_agents WHERE roomId=? AND agentId=?')
      .get(run.roomId, run.targetAgentId) as Record<string, unknown> | undefined
    if (Number(room?.ownerAuthUserId) !== run.ownerAuthUserId || queue?.roomId !== run.roomId
        || queue.messageId !== run.messageId || queue.targetAgentId !== run.targetAgentId
        || queue.requesterMemberId !== run.requesterMemberId || queue.sequence !== run.sourceEventSeq
        || queue.status !== 'running' || source?.roomId !== run.roomId
        || source.senderId !== run.requesterMemberId || source.role !== 'user'
        || typeof source.content !== 'string'
        || createHash('sha256').update(source.content).digest('hex') !== run.sourceDigest
        || !agent || agent.removedAt !== 0 || String(agent.ownerMemberId || '') !== run.agentOwnerMemberId) {
      throw new Error('Hermes private result authority changed')
    }
    const terminal: unknown = JSON.parse(run.terminalJson)
    if (!hasHermesCompleteTextReply(terminal) || terminal.run_id !== run.runId) {
      throw new Error('Hermes private result has no complete text reply')
    }
    const now = Date.now()
    const consumed = db.prepare(`UPDATE gc_hermes_hosted_room_runs SET publishedAt=?,updatedAt=?
      WHERE queueId=? AND deliveryMode='private' AND publishedAt IS NULL`).run(now, now, queueId)
    const completed = db.prepare(`UPDATE gc_execution_queue SET status='completed',finishedAt=?,lastError=NULL
      WHERE id=? AND status='running'`).run(now, queueId)
    if (consumed.changes !== 1 || completed.changes !== 1) throw new Error('Hermes private result consumption changed')
    db.exec('COMMIT')
    return terminal.output
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

/** One transaction checks present authority, inserts the result, and marks delivery. */
export function publishHermesHostedRoomResult(options: {
  db: DatabaseSync
  queueId: string
  persist: (message: HostedRoomMessage) => void
  notify: (message: HostedRoomMessage) => void
}): 'published' | 'already_published' {
  const { db, queueId } = options
  let message: HostedRoomMessage | null = null
  let published = false
  db.exec('BEGIN IMMEDIATE')
  try {
    const run = getHermesHostedRoomRun(db, queueId)
    if (!run || run.deliveryMode !== 'public' || run.state !== 'completed' || !run.runId || !run.terminalJson) {
      throw new Error('Hermes hosted-room result is not terminal')
    }
    const room = db.prepare('SELECT ownerAuthUserId FROM gc_rooms WHERE id=?').get(run.roomId) as Record<string, unknown> | undefined
    const queue = db.prepare(`SELECT roomId,messageId,targetAgentId,requesterMemberId,sequence,status
      FROM gc_execution_queue WHERE id=?`).get(queueId) as Record<string, unknown> | undefined
    const source = db.prepare('SELECT roomId,senderId,role,content FROM gc_messages WHERE id=?')
      .get(run.messageId) as Record<string, unknown> | undefined
    const agent = db.prepare('SELECT name,removedAt,ownerMemberId FROM gc_room_agents WHERE roomId=? AND agentId=?')
      .get(run.roomId, run.targetAgentId) as Record<string, unknown> | undefined
    const peer = source?.role === 'assistant'
      ? db.prepare('SELECT removedAt FROM gc_room_agents WHERE roomId=? AND agentId=?')
        .get(run.roomId, String(source.senderId || '')) as Record<string, unknown> | undefined
      : null
    if (Number(room?.ownerAuthUserId) !== run.ownerAuthUserId
        || queue?.roomId !== run.roomId || queue.messageId !== run.messageId
        || queue.targetAgentId !== run.targetAgentId || queue.requesterMemberId !== run.requesterMemberId
        || queue.sequence !== run.sourceEventSeq
        || !(run.publishedMessageId ? queue.status === 'completed' : ['running', 'failed'].includes(String(queue.status)))
        || source?.roomId !== run.roomId || source.senderId !== run.requesterMemberId
        || (source.role !== 'user' && !(source.role === 'assistant' && peer?.removedAt === 0))
        || typeof source.content !== 'string'
        || createHash('sha256').update(source.content).digest('hex') !== run.sourceDigest
        || !agent || agent.removedAt !== 0 || String(agent.ownerMemberId || '') !== run.agentOwnerMemberId) {
      throw new Error('Hermes hosted-room publication authority changed')
    }
    const terminal: unknown = JSON.parse(run.terminalJson)
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) throw new Error('Invalid Hermes terminal receipt')
    if (!hasHermesCompleteTextReply(terminal) || terminal.run_id !== run.runId) {
      throw new Error('Hermes hosted-room result has no complete text reply')
    }
    const status = terminal
    message = {
      id: `gcvm_${createHash('sha256').update(queueId).digest('hex')}`,
      roomId: run.roomId, senderId: run.targetAgentId, senderName: String(agent.name || run.targetAgentId),
      senderType: 'agent', role: 'assistant', content: status.output,
      timestamp: Date.now(), run_id: run.runId, mentions: [],
    }
    const existing = db.prepare('SELECT roomId,senderId,role,content,run_id FROM gc_messages WHERE id=?')
      .get(message.id) as Record<string, unknown> | undefined
    if (existing && (existing.roomId !== message.roomId || existing.senderId !== message.senderId
        || existing.role !== message.role || existing.content !== message.content
        || existing.run_id !== message.run_id)) throw new Error('Hermes hosted-room publication collision')
    if (run.publishedMessageId) {
      if (run.publishedMessageId !== message.id || !existing) throw new Error('Hermes hosted-room publication marker changed')
    } else {
      if (existing) throw new Error('Hermes hosted-room result exists without a publication marker')
      options.persist(message)
      const saved = db.prepare('SELECT roomId,senderId,role,content,run_id FROM gc_messages WHERE id=?')
        .get(message.id) as Record<string, unknown> | undefined
      if (!saved || saved.roomId !== message.roomId || saved.senderId !== message.senderId
          || saved.role !== message.role || saved.content !== message.content || saved.run_id !== message.run_id) {
        throw new Error('Hermes hosted-room result was not persisted')
      }
      const updated = db.prepare(`UPDATE gc_hermes_hosted_room_runs
        SET publishedMessageId=?,publishedAt=?,updatedAt=?
        WHERE queueId=? AND state='completed' AND publishedMessageId IS NULL`).run(
        message.id, Date.now(), Date.now(), queueId,
      )
      if (updated.changes !== 1) throw new Error('Hermes hosted-room publication claim changed')
      const completed = db.prepare(`UPDATE gc_execution_queue
        SET status='completed',finishedAt=?,lastError=NULL
        WHERE id=? AND status IN ('running','failed')`).run(Date.now(), queueId)
      if (completed.changes !== 1) throw new Error('Hermes hosted-room queue completion changed')
      published = true
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  if (published) options.notify(message!)
  return published ? 'published' : 'already_published'
}
