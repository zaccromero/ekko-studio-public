import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('stored session tool-call statistics', () => {
  let db: any
  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db, isSqliteAvailable: () => true, getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })
  afterEach(() => {
    db.close()
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  async function fixture() {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 's', source: 'builtin_agent', agent: 'ekko-agent' })
    const add = (role: string, extra = {}) => store.addMessage({ session_id: 's', role, content: '', ...extra })!
    const call = (id: string) => ({ id, type: 'function', function: { name: 'terminal_exec', arguments: '{}' } })
    return { ...store, add, call }
  }

  it('counts one saved command call once across its result and repeated stats refreshes', async () => {
    const f = await fixture()
    f.add('user', { content: 'Run the prescribed command once.' })
    f.add('assistant', { tool_calls: [f.call('one')] })
    f.add('tool', { tool_call_id: 'one', tool_name: 'terminal_exec', content: 'result' })
    f.add('assistant', { content: 'result' })
    f.updateSessionStats('s')
    f.updateSessionStats('s')
    expect(f.getSession('s')).toMatchObject({ message_count: 4, tool_call_count: 1 })
  })

  it('counts batched model calls individually without adding result rows', async () => {
    const f = await fixture()
    f.add('assistant', { tool_calls: [f.call('a'), f.call('b')] })
    f.add('assistant', { tool_calls: [f.call('c')] })
    for (const id of ['a', 'b', 'c']) f.add('tool', { tool_call_id: id, tool_name: 'terminal_exec' })
    f.updateSessionStats('s')
    expect(f.getSession('s')).toMatchObject({ message_count: 5, tool_call_count: 3 })
  })

  it('ignores malformed and non-array stored JSON while counting valid arrays', async () => {
    const f = await fixture()
    for (const value of ['broken {', '{}', '"text"', '3', 'null']) {
      const id = f.add('assistant')
      db.prepare('UPDATE messages SET tool_calls = ? WHERE id = ?').run(value, id)
    }
    f.add('assistant', { tool_calls: [f.call('valid')] })
    expect(() => f.updateSessionStats('s')).not.toThrow()
    expect(f.getSession('s')?.tool_call_count).toBe(1)
  })

  it('resets a stale count to zero when no stored calls remain', async () => {
    const f = await fixture()
    f.add('user', { content: 'Hello' })
    db.prepare('UPDATE sessions SET tool_call_count = 7 WHERE id = ?').run('s')
    f.updateSessionStats('s')
    expect(f.getSession('s')).toMatchObject({ message_count: 1, tool_call_count: 0 })
  })

  it('updates only the selected session', async () => {
    const f = await fixture()
    f.createSession({ id: 'other', source: 'builtin_agent' })
    db.prepare('UPDATE sessions SET tool_call_count = 9 WHERE id = ?').run('other')
    f.add('assistant', { tool_calls: [f.call('s-only')] })
    f.updateSessionStats('s')
    expect(f.getSession('s')?.tool_call_count).toBe(1)
    expect(f.getSession('other')?.tool_call_count).toBe(9)
  })
})
