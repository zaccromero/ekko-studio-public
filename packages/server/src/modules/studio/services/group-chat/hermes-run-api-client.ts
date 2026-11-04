/** Scoped hosted-room transport. Grant issuance and durable queue binding are separate. */
export type HermesRunStatus = {
  object: 'hermes.run'
  run_id: string
  status: string
  created_at?: number
  updated_at?: number
  output?: unknown
  error?: unknown
  [key: string]: unknown
}

export type HermesRunAdmission = {
  run_id: string
  status: string
  replayed?: boolean
  [key: string]: unknown
}

/** Exact hosted-room wire shape from the VM's HostedMemberDispatch.as_mapping(). */
export type HermesHostedRoomDispatch = {
  protocol_version: number
  room_id: string
  home_install_id: string
  authority_gateway_id: string
  authority_epoch: number
  member_id: string
  target_install_id: string
  target_profile: string
  task_id: string
  execution_generation: number
  source_event_seq: number
  cancellation_scope_id: string
  prompt: string
  prompt_digest: string
  capability_digest: string
  execution_policy_digest: string
  trace_id: string
}

export const HERMES_HOSTED_ROOM_PROTOCOL_VERSION = 2

export type HermesRunDisposition = 'completed' | 'failed' | 'needs_approval' | 'pending' | 'unknown'

/** A submission error cannot establish whether the VM admitted the keyed run. */
export class HermesAdmissionUnknownError extends Error {
  constructor(readonly idempotencyKey: string) {
    super('Hermes Run API admission outcome is unknown; reconcile with the same key')
    this.name = 'HermesAdmissionUnknownError'
  }
}

/** Classify a durable status without guessing that silence or a timeout means completion. */
export function classifyHermesRun(status: HermesRunStatus): HermesRunDisposition {
  switch (status.status) {
    case 'completed': return 'completed'
    case 'failed':
    case 'cancelled':
    case 'interrupted': return 'failed'
    case 'waiting_for_approval': return 'needs_approval'
    case 'queued':
    case 'running':
    case 'stopping': return 'pending'
    default: return 'unknown'
  }
}

type Transport = typeof fetch

export class HermesRunApiClient {
  private readonly base: URL

  constructor(
    baseUrl: string,
    private readonly authorization: () => string,
    private readonly transport: Transport = fetch,
  ) {
    const base = new URL(baseUrl)
    if (!['https:', 'http:'].includes(base.protocol)) throw new Error('Unsupported Hermes Run API protocol')
    if (base.username || base.password || base.search || base.hash) throw new Error('Run API base URL must not contain credentials, query, or fragment')
    if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
      throw new Error('Remote Hermes Run API requires HTTPS')
    }
    this.base = new URL(base.toString().replace(/\/*$/, '/'))
  }

  async submitRoomDispatch(dispatch: HermesHostedRoomDispatch): Promise<HermesRunAdmission> {
    if (dispatch.protocol_version !== HERMES_HOSTED_ROOM_PROTOCOL_VERSION
        || !dispatch.prompt.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(dispatch.task_id)
        || !Number.isSafeInteger(dispatch.execution_generation) || dispatch.execution_generation <= 0) {
      throw new Error('Invalid hosted room dispatch identity')
    }
    const idempotencyKey = `room:${dispatch.task_id}:${dispatch.execution_generation}`
    if (idempotencyKey.length > 255) throw new Error('Hosted room idempotency key is too long')
    let response: Record<string, unknown>
    try {
      response = await this.request('v1/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ input: dispatch.prompt, hosted_room_dispatch: dispatch }),
      })
    } catch {
      throw new HermesAdmissionUnknownError(idempotencyKey)
    }
    if (typeof response.run_id !== 'string' || !response.run_id || typeof response.status !== 'string') {
      throw new HermesAdmissionUnknownError(idempotencyKey)
    }
    return { ...response, run_id: response.run_id, status: response.status }
  }

  async status(runId: string): Promise<HermesRunStatus> {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Invalid Hermes run ID')
    const response = await this.request(`v1/runs/${runId}`, { method: 'GET' })
    if (response.run_id !== runId || typeof response.status !== 'string') {
      throw new Error('Hermes Run API returned a mismatched run status')
    }
    if (response.object !== 'hermes.run') throw new Error('Hermes Run API returned the wrong object type')
    return { ...response, object: 'hermes.run', run_id: runId, status: response.status }
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const token = this.authorization()
    if (!token || /[\r\n]/.test(token)) throw new Error('Hermes Run API credential is unavailable')
    const headers = new Headers(init.headers)
    headers.set('Authorization', `HermesRoom ${token}`)
    headers.set('Accept', 'application/json')
    const response = await this.transport(new URL(path, this.base), {
      ...init,
      headers,
      redirect: 'error',
      signal: init.signal || AbortSignal.timeout(15_000),
    })
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.toLowerCase().includes('application/json')) throw new Error('Hermes Run API did not return JSON')
    if (!response.ok) throw new Error(`Hermes Run API returned HTTP ${response.status}`)
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hermes Run API returned an invalid object')
    return value as Record<string, unknown>
  }
}
