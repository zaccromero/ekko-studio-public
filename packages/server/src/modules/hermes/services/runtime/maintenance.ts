import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'

export type RuntimeMaintenanceStatus = 'ready' | 'degraded' | 'unknown'

export type RuntimeMaintenanceCode =
  | 'managed-python-missing'
  | 'payload-manifest-invalid'
  | 'managed-python-dangling'

export interface RuntimeMaintenanceResult {
  status: RuntimeMaintenanceStatus
  code?: RuntimeMaintenanceCode
}

interface PayloadManifest {
  store?: unknown
}

interface ToolFacts {
  packages?: {
    python?: {
      entry?: unknown
    }
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function isSameOrNestedPath(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function inspectRuntimeMaintenance(runtimeRoot: string): RuntimeMaintenanceResult {
  const pythonRoot = resolve(runtimeRoot, 'python')
  const manifestPath = resolve(pythonRoot, 'manifest.json')
  if (!existsSync(manifestPath)) return { status: 'unknown' }

  const manifest = readJson<PayloadManifest>(manifestPath)
  const store = typeof manifest?.store === 'string' ? manifest.store.trim() : ''
  if (!store || isAbsolute(store)) {
    return { status: 'degraded', code: 'payload-manifest-invalid' }
  }

  const storeRoot = resolve(pythonRoot, store)
  if (!isSameOrNestedPath(pythonRoot, storeRoot)) {
    return { status: 'degraded', code: 'payload-manifest-invalid' }
  }

  const facts = readJson<ToolFacts>(resolve(storeRoot, 'facts.json'))
  const entry = typeof facts?.packages?.python?.entry === 'string'
    ? facts.packages.python.entry.trim()
    : ''
  if (!entry || isAbsolute(entry)) {
    return { status: 'degraded', code: 'managed-python-missing' }
  }

  const entryRoot = resolve(storeRoot, entry)
  if (!isSameOrNestedPath(storeRoot, entryRoot)) {
    return { status: 'degraded', code: 'payload-manifest-invalid' }
  }

  const candidate = process.platform === 'win32'
    ? resolve(entryRoot, 'python.exe')
    : resolve(entryRoot, 'bin', 'python3')
  try {
    const realPythonRoot = realpathSync(pythonRoot)
    const realStoreRoot = realpathSync(storeRoot)
    if (!isSameOrNestedPath(realPythonRoot, realStoreRoot)) {
      return { status: 'degraded', code: 'payload-manifest-invalid' }
    }
    if (!statSync(candidate).isFile()) {
      return { status: 'degraded', code: 'managed-python-dangling' }
    }
    const realCandidate = realpathSync(candidate)
    if (!isSameOrNestedPath(realStoreRoot, realCandidate)) {
      return { status: 'degraded', code: 'payload-manifest-invalid' }
    }
    if (process.platform !== 'win32' && (statSync(realCandidate).mode & 0o111) === 0) {
      return { status: 'degraded', code: 'managed-python-dangling' }
    }
  } catch {
    return { status: 'degraded', code: 'managed-python-dangling' }
  }

  return { status: 'ready' }
}
