import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntime, AgentToolRegistry } from '../../packages/ekko-agent/src/index'
import type { ModelClient, ModelRequest } from '../../packages/ekko-agent/src/index'

const watcher = vi.hoisted(() => ({
  notify: () => {},
  fail: () => {},
  closed: false,
}))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { EventEmitter } = await import('node:events')
  return {
    ...actual,
    watch: (_directory: unknown, _options: unknown, listener: () => void) => {
      const events = new EventEmitter()
      watcher.closed = false
      watcher.notify = () => listener()
      watcher.fail = () => events.emit('error', new Error('fixture watcher error'))
      return Object.assign(events, { close: () => { watcher.closed = true } })
    },
  }
})

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function writeSkill(directory: string, name: string, body: string) {
  await mkdir(join(directory, name), { recursive: true })
  await writeFile(join(directory, name, 'SKILL.md'), [
    '---', `name: ${name}`, 'description: Fixture only.', '---', body,
  ].join('\n'))
}

async function runCommand(mutate: (directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ekko-skill-events-'))
  roots.push(root)
  const skillDirectory = join(root, 'skills')
  await writeSkill(skillDirectory, 'existing-invalid', 'Unchanged invalid metadata.')
  const tools = new AgentToolRegistry()
  tools.register({
    definition: { name: 'terminal_exec', parameters: { type: 'object', properties: {} } },
    execute: async () => {
      await mutate(skillDirectory)
      return { ok: true, content: 'command output' }
    },
  })
  let calls = 0
  let terminalResult: string | undefined
  const modelClient: ModelClient = {
    provider: 'test', requestStyle: 'custom-runtime',
    capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
    stream: vi.fn(),
    create: vi.fn(async (request: ModelRequest) => {
      if (++calls === 1) return { toolCalls: [{ id: 'command', name: 'terminal_exec', arguments: { command: 'fixture' } }] }
      terminalResult = request.messages.find(message => message.role === 'tool' && message.name === 'terminal_exec')?.content
      return { content: 'done' }
    }),
  }
  await new AgentRuntime({ modelClient, tools, skillDirectory }).run({ messages: ['Run a command.'] })
  expect(calls).toBe(2)
  expect(watcher.closed).toBe(true)
  return terminalResult
}

describe('terminal Skill validation change detection', () => {
  it.each(['event', 'error'] as const)('does not append existing validation issues after a spurious watcher %s', async kind => {
    const content = await runCommand(async () => {
      if (kind === 'event') watcher.notify()
      else watcher.fail()
    })
    expect(content).toBe('command output')
  })

  it.each([true, false])('still reports a new invalid install with watcher notification=%s', async notify => {
    const content = await runCommand(async directory => {
      await writeSkill(directory, 'new-invalid', 'Newly installed invalid metadata.')
      if (notify) watcher.notify()
    })
    expect(content).toContain('command output')
    expect(content).toContain('[skill_validation]')
    expect(content).toContain('new-invalid (needs_metadata)')
  })

  it('reports an edited invalid Skill even when its validation status is unchanged', async () => {
    const content = await runCommand(async directory => {
      await writeSkill(directory, 'existing-invalid', 'Changed invalid metadata.')
      watcher.notify()
    })
    expect(content).toContain('[skill_validation]')
    expect(content).toContain('existing-invalid (needs_metadata)')
  })
})
