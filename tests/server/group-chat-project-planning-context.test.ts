import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownerProjectPlanningContext, projectPlanningContext } from '../../packages/server/src/modules/studio/services/group-chat/project-planning-context'

const base = mkdtempSync(join(tmpdir(), 'ekko-project-read-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

function repo(name: string, content: string): { id: string; root: string; commit: string; paths: string[] } {
  const root = join(base, name)
  mkdirSync(root)
  execFileSync('git', ['init', '-q', root])
  writeFileSync(join(root, 'README.md'), content)
  execFileSync('git', ['-C', root, 'add', 'README.md'])
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'source'])
  return { id: name, root, commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), paths: ['README.md'] }
}

const projects = [repo('drako-os', 'Drako source at pinned commit.'), repo('ekko-studio', 'Ekko source at pinned commit.')]
const manifestPath = join(base, 'manifest.json')
const env = { EKKO_GROUP_CHAT_PROJECT_READ_MANIFEST: manifestPath }
function manifest(projectsToUse = projects, roomId = 'bridge-room') {
  writeFileSync(manifestPath, JSON.stringify({ roomId, projects: projectsToUse }))
}

describe('owner-scoped project planning context', () => {
  it('is default off, exact-room only, and pins text to a commit', () => {
    manifest()
    expect(projectPlanningContext('bridge-room', {})).toBe('')
    expect(projectPlanningContext('other-room', env)).toBe('')
    const text = projectPlanningContext('bridge-room', env)
    expect(text).toContain('Drako source at pinned commit.')
    expect(text).toContain('Ekko source at pinned commit.')
    expect(text).toContain(projects[0].commit)
    writeFileSync(join(projects[0].root, 'README.md'), 'Dirty working tree must not leak.')
    expect(projectPlanningContext('bridge-room', env)).not.toContain('Dirty working tree')
  })

  it('rejects expanded scope, traversal and untracked content', () => {
    manifest([{ ...projects[0], id: 'other-project' }, projects[1]])
    expect(() => projectPlanningContext('bridge-room', env)).toThrow('scope')
    manifest([{ ...projects[0], paths: ['../outside'] }, projects[1]])
    expect(() => projectPlanningContext('bridge-room', env)).toThrow('path')
    manifest([{ ...projects[0], paths: ['untracked.txt'] }, projects[1]])
    expect(() => projectPlanningContext('bridge-room', env)).toThrow('regular tracked file')
  })

  it('withholds project text from other room members and agent merge turns', () => {
    manifest()
    expect(ownerProjectPlanningContext('bridge-room', 'other-member', 'owner-member', env)).toBe('')
    expect(ownerProjectPlanningContext('bridge-room', 'agent-merge', 'owner-member', env)).toBe('')
    expect(ownerProjectPlanningContext('bridge-room', 'owner-member', undefined, env)).toBe('')
    expect(ownerProjectPlanningContext('bridge-room', 'owner-member', 'owner-member', env)).toContain('Drako source')
  })
})
