import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestGroupChatServer } from './group-chat-test-helpers'
import {
  getAllOneJournal, recordAllOneContribution, reserveAllOneJournal,
} from '../../packages/server/src/modules/studio/services/group-chat/allone-journal'

const harnesses: Array<Awaited<ReturnType<typeof createTestGroupChatServer>>> = []
afterEach(() => { for (const harness of harnesses.splice(0)) harness.cleanup() })

describe('room @allone restart recovery', () => {
  it('posts one saved answer from prior private results without invoking a model again', async () => {
    const harness = await createTestGroupChatServer()
    harnesses.push(harness)
    const { db, groupServer } = harness
    const storage = groupServer.getStorage()
    storage.saveRoom('room', 'Recovery room', '', { ownerAuthUserId: 42 })
    storage.addRoomAgent('room', 'codex', 'default', 'Codex', '', 0)
    storage.addRoomAgent('room', 'hermes', 'default', 'Hermes', '', 0)
    storage.saveMessageAndRefreshRoom({ id: 'source', roomId: 'room', senderId: 'owner',
      senderName: 'Owner', role: 'user', content: '/allone plan', timestamp: 1 } as any)
    reserveAllOneJournal(db, { messageId: 'source', roomId: 'room', requesterMemberId: 'owner',
      contributors: [{ agentId: 'codex', name: 'Codex' }, { agentId: 'hermes', name: 'Hermes' }] })
    recordAllOneContribution(db, { messageId: 'source', agentId: 'hermes', agentName: 'Hermes',
      text: 'Private VM reply', error: null, finishedAt: 100 })
    db.prepare('UPDATE gc_allone_journal SET createdAt=1,updatedAt=1 WHERE messageId=?').run('source')

    const postOutsideRun = vi.fn(async (_roomId: string, content: string, id: string) => {
      storage.saveMessageAndRefreshRoom({ id, roomId: 'room', senderId: 'codex',
        senderName: 'Codex', role: 'assistant', content, timestamp: Date.now() } as any)
      return id
    })
    const getAgent = vi.spyOn(groupServer.agentClients, 'getAgent').mockImplementation((_roomId, agentId) =>
      agentId === 'codex' ? { agentId: 'codex', connected: true, requiresDurableQueue: false,
        postOutsideRun } as any : undefined)

    await (groupServer as any).reconcileAllOneJournal()
    expect(postOutsideRun).toHaveBeenCalledTimes(1)
    expect(getAllOneJournal(db, 'source')?.state).toBe('published')
    const answerId = getAllOneJournal(db, 'source')?.publishedMessageId || ''
    expect(storage.getMessage(answerId)?.content).toContain('Private VM reply')
    expect(storage.getMessage(answerId)?.content).toContain('no request was replayed')
    await (groupServer as any).reconcileAllOneJournal()
    expect(postOutsideRun).toHaveBeenCalledTimes(1)
    expect(getAgent).toHaveBeenCalled()
  })
})
