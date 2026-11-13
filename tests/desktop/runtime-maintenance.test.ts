import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectRuntimeMaintenance } from '../../packages/desktop/src/main/runtime-maintenance'

const roots: string[] = []

function runtimeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ekko-runtime-maintenance-'))
  roots.push(root)
  mkdirSync(join(root, 'python'), { recursive: true })
  return root
}

function writePayload(root: string, facts: unknown): void {
  writeFileSync(join(root, 'python', 'manifest.json'), JSON.stringify({
    studioRuntime: 1,
    repo: '.',
    venv: 'venv',
    store: 'runtime-tools',
  }))
  mkdirSync(join(root, 'python', 'runtime-tools'), { recursive: true })
  writeFileSync(join(root, 'python', 'runtime-tools', 'facts.json'), JSON.stringify(facts))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop Runtime maintenance inspection', () => {
  it('keeps legacy payloads without a payload manifest compatible', () => {
    expect(inspectRuntimeMaintenance(runtimeRoot())).toEqual({ status: 'unknown' })
  })

  it('classifies the recovered 0.23.0 bundle shape as degraded', () => {
    const root = runtimeRoot()
    writePayload(root, { packages: { chromium: { entry: 'chromium-1208' } } })
    expect(inspectRuntimeMaintenance(root)).toEqual({
      status: 'degraded',
      code: 'managed-python-missing',
    })
  })

  it('distinguishes a dangling managed Python entry', () => {
    const root = runtimeRoot()
    writePayload(root, { packages: { python: { entry: 'python-fixture' } } })
    expect(inspectRuntimeMaintenance(root)).toEqual({
      status: 'degraded',
      code: 'managed-python-dangling',
    })
  })

  it('accepts an executable managed Python contained by the payload store', () => {
    const root = runtimeRoot()
    writePayload(root, { packages: { python: { entry: 'python-fixture' } } })
    const python = process.platform === 'win32'
      ? join(root, 'python', 'runtime-tools', 'python-fixture', 'python.exe')
      : join(root, 'python', 'runtime-tools', 'python-fixture', 'bin', 'python3')
    mkdirSync(join(python, '..'), { recursive: true })
    writeFileSync(python, '')
    if (process.platform !== 'win32') chmodSync(python, 0o755)
    expect(inspectRuntimeMaintenance(root)).toEqual({ status: 'ready' })
  })

  it('rejects payload stores that escape the Runtime', () => {
    const root = runtimeRoot()
    writeFileSync(join(root, 'python', 'manifest.json'), JSON.stringify({ store: '../../outside' }))
    expect(inspectRuntimeMaintenance(root)).toEqual({
      status: 'degraded',
      code: 'payload-manifest-invalid',
    })
  })

  it.runIf(process.platform !== 'win32')('rejects payload stores that resolve outside the Runtime', () => {
    const root = runtimeRoot()
    const outside = mkdtempSync(join(tmpdir(), 'ekko-runtime-maintenance-outside-'))
    roots.push(outside)
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
