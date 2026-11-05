/** Bounded Personal cloud chat transport. Room publication is a separate authority step. */
export type CloudflarePersonalChatReply = {
  answer: string
  correlationId: string
  idempotencyKey: string
  runtimeInstanceId: string
  sourceCommit: string
  cloudflareVersionId: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class CloudflarePersonalChatError extends Error {
  constructor(message: string, readonly outcome: 'refused' | 'unknown') {
    super(message)
  }
}

export class CloudflarePersonalChatClient {
  private readonly endpoint: URL
  private readonly healthEndpoint: URL

  constructor(
    endpointUrl: string,
    private readonly expectedSourceCommit: string,
    private readonly credential: () => string,
    private readonly transport: typeof fetch = fetch,
  ) {
    const endpoint = new URL(endpointUrl)
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
        || endpoint.search || endpoint.hash || endpoint.pathname !== '/v1/chat') {
      throw new Error('Personal cloud chat requires a fixed HTTPS /v1/chat endpoint')
    }
    if (!/^[a-f0-9]{40}$/.test(expectedSourceCommit)) {
      throw new Error('Personal cloud chat source commit is not pinned')
    }
    this.endpoint = endpoint
    this.healthEndpoint = new URL('/health', endpoint)
  }

  private async assertLiveSource(): Promise<void> {
    let response: Response
    try {
      response = await this.transport(this.healthEndpoint, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/json' },
      })
    } catch {
      throw new CloudflarePersonalChatError('Personal cloud health is unavailable', 'refused')
    }
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new CloudflarePersonalChatError('Personal cloud health is unavailable', 'refused')
    }
    let data: unknown
    try { data = await response.json() }
    catch { throw new CloudflarePersonalChatError('Personal cloud health is invalid', 'refused') }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new CloudflarePersonalChatError('Personal cloud health is invalid', 'refused')
    }
    const health = data as Record<string, unknown>
    if (health.healthy !== true || health.identity !== 'drako.hermes.personal'
        || health.ingressAuthenticationConfigured !== true
        || health.sourceCommit !== this.expectedSourceCommit
        || health.persistedSourceCommit !== this.expectedSourceCommit) {
      throw new CloudflarePersonalChatError('Personal cloud source or identity changed', 'refused')
    }
  }

  async ask(question: string, idempotencyKey: string): Promise<CloudflarePersonalChatReply> {
    if (!question.trim() || question.length > 4_000) {
      throw new Error('Personal cloud chat question is invalid')
    }
    if (!UUID.test(idempotencyKey)) throw new Error('Personal cloud chat idempotency key is invalid')
    await this.assertLiveSource()
    const token = this.credential()
    if (!token || /[\r\n]/.test(token)) throw new Error('Personal cloud chat credential is unavailable')
    let response: Response
    try {
      response = await this.transport(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ question, requested_capabilities: [] }),
        redirect: 'error',
        signal: AbortSignal.timeout(45_000),
      })
    } catch {
      throw new CloudflarePersonalChatError('Personal cloud chat delivery outcome is unknown', 'unknown')
    }
    // The current Cloudflare API returns 409 for every duplicate, including a
    // successful first request. It does not provide result readback by key.
    if (!response.ok) throw new CloudflarePersonalChatError(
      `Personal cloud chat HTTP ${response.status}`,
      response.status === 409 || response.status >= 500 ? 'unknown' : 'refused',
    )
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new CloudflarePersonalChatError('Personal cloud chat did not return JSON', 'unknown')
    }
    let data: unknown
    try {
      data = await response.json()
    } catch {
      throw new CloudflarePersonalChatError('Personal cloud chat returned invalid JSON', 'unknown')
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new CloudflarePersonalChatError('Personal cloud chat returned an invalid reply', 'unknown')
    }
    const reply = data as Record<string, unknown>
    for (const field of ['answer', 'correlationId', 'idempotencyKey', 'runtimeInstanceId', 'sourceCommit', 'cloudflareVersionId']) {
      if (typeof reply[field] !== 'string' || !reply[field]) {
        throw new CloudflarePersonalChatError('Personal cloud chat returned an incomplete reply', 'unknown')
      }
    }
    if (reply.ok !== true || reply.idempotencyKey !== idempotencyKey
        || reply.sourceCommit !== this.expectedSourceCommit || reply.answer === '') {
      throw new CloudflarePersonalChatError('Personal cloud chat returned a mismatched reply', 'unknown')
    }
    return reply as CloudflarePersonalChatReply
  }
}
