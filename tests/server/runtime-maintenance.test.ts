import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectRuntimeMaintenance } from '../../packages/server/src/modules/hermes/services/runtime/maintenance'

const roots: string[] = []

function fixture(facts: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'ekko-server-runtime-maintenance-'))
  roots.push(root)
  mkdirSync(join(root, 'python', 'runtime-tools'), { recursive: true })
  writeFileSync(join(root, 'python', 'manifest.json'), JSON.stringify({ store: 'runtime-tools' }))
  writeFileSync(join(root, 'python', 'runtime-tools', 'facts.json'), JSON.stringify(facts))
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('server Runtime maintenance inspection', () => {
  it('reports missing and valid managed Python without exposing paths', () => {
    expect(inspectRuntimeMaintenance(fixture({ packages: { chromium: { entry: 'chromium' } } })))
      .toEqual({ status: 'degraded', code: 'managed-python-missing' })

    const root = fixture({ packages: { python: { entry: 'python-fixture' } } })
    const python = process.platform === 'win32'
      ? join(root, 'python', 'runtime-tools', 'python-fixture', 'python.exe')
      : join(root, 'python', 'runtime-tools', 'python-fixture', 'bin', 'python3')
    mkdirSync(join(python, '..'), { recursive: true })
    writeFileSync(python, '')
    if (process.platform !== 'win32') chmodSync(python, 0o755)
    expect(inspectRuntimeMaintenance(root)).toEqual({ status: 'ready' })
  })

  it.runIf(process.platform !== 'win32')('rejects a managed tool store symlink outside the payload', () => {
    const root = mkdtempSync(join(tmpdir(), 'ekko-server-runtime-maintenance-link-'))
    const outside = mkdtempSync(join(tmpdir(), 'ekko-server-runtime-maintenance-outside-'))
    roots.push(root, outside)
    mkdirSync(join(root, 'python'), { recursive: true })
    mkdirSync(join(outside, 'python-fixture', 'bin'), { recursive: true })
    writeFileSync(join(outside, 'facts.json'), JSON.stringify({
      packages: { python: { entry: 'python-fixture' } },
    }))
    writeFileSync(join(outside, 'python-fixture', 'bin', 'python3'), '')
    chmodSync(join(outside, 'python-fixture', 'bin', 'python3'), 0o755)
    symlinkSync(outside, join(root, 'python', 'runtime-tools'))
    writeFileSync(join(root, 'python', 'manifest.json'), JSON.stringify({ store: 'runtime-tools' }))

    expect(inspectRuntimeMaintenance(root)).toEqual({
      status: 'degraded',
      code: 'payload-manifest-invalid',
    })
  })
})
