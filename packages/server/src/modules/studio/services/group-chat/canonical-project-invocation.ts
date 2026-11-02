import { createHash } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import {
    ProjectInvocationError,
    type BoundProjectInvocation,
    type ProjectCarrier,
    type ProjectInvocationHost,
    type ProjectInvocationTarget,
} from './project-invocation'

const MAX_BYTES = 1024 * 1024
const MAX_FRAME = 2 * MAX_BYTES
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
type Target = Readonly<ProjectInvocationTarget>
type RecordValue = Record<string, unknown>

export interface CanonicalInvocationHooks {
    /** Canonical project-carrier.mjs parser loaded by fixed protected composition. */
    parseCarrier(raw: unknown): ProjectCarrier
    /** Verify actual prepared inputs/executor against approved bytes, invoke once,
     * await its full reply, and return the exact internal result to journal.
     * This must also enforce consequential sub-effects; no preflight-only hook.
     */
    effect(binding: BoundProjectInvocation, target: Target, approvedPayload: Uint8Array,
        invoke: () => Promise<void>): Promise<Uint8Array>
    /** Independent same-request validation, never a room/agent-supplied approval. */
    verifyResult(binding: BoundProjectInvocation, target: Target, savedResult: Uint8Array): Promise<void>
}

type Pending = {
    method: string
    target: Target
    binding?: BoundProjectInvocation
    invoke?: () => Promise<void>
    started: boolean
    settled: boolean
    failed: boolean
    callback?: Promise<void>
    digest?: string
    resolve(value: unknown): void
    reject(error: unknown): void
}

function exact(value: unknown, keys: string[]): asserts value is RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
        throw new ProjectInvocationError('INVALID_CANONICAL_CHANNEL_FRAME', false)
    }
}
function same(a: unknown, b: unknown): boolean {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b
    const x = a as RecordValue, y = b as RecordValue
    const keys = Object.keys(x).sort()
    return keys.join(',') === Object.keys(y).sort().join(',') && keys.every(k => same(x[k], y[k]))
}
function bytes(value: unknown): Buffer {
    if (typeof value !== 'string' || value.length > 4 * Math.ceil(MAX_BYTES / 3)) {
        throw new ProjectInvocationError('BOUNDED_CANONICAL_BYTES_REQUIRED', true)
    }
    const decoded = Buffer.from(value, 'base64')
    if (decoded.length > MAX_BYTES || decoded.toString('base64') !== value) {
        throw new ProjectInvocationError('INVALID_CANONICAL_BYTES', true)
    }
    return decoded
}
function digest(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function target(value: Target): Target {
    exact(value, ['roomId', 'messageId', 'agentId', 'queueId'])
    const copy = Object.freeze({ roomId: value.roomId, messageId: value.messageId, agentId: value.agentId, queueId: value.queueId })
    exact(copy, ['roomId', 'messageId', 'agentId', 'queueId'])
    if (!Object.values(copy).every(v => typeof v === 'string' && idPattern.test(v))) {
        throw new ProjectInvocationError('VERIFIED_FULL_TARGET_REQUIRED', false)
    }
    return copy
}

/** Private host-owned stream transport only; no socket, credentials or launcher.
 * Constructing this service never enables production AgentClients by itself.
 */
export class CanonicalProjectInvocationHost implements ProjectInvocationHost {
    readonly parseCarrier: (raw: unknown) => ProjectCarrier
    private readonly hooks: Readonly<CanonicalInvocationHooks>
    private readonly pending = new Map<string, Pending>()
    private readonly completed = new Map<string, { binding: BoundProjectInvocation; digest: string }>()
    private sequence = 0
    private input = Buffer.alloc(0)
    private failed = false
    private closing = false
    private readySeen = false
    private closedSeen = false
    private readonly ready: Promise<void>
    private readyResolve!: () => void
    private readyReject!: (error: unknown) => void
    private readonly closed: Promise<void>
    private closedResolve!: () => void
    private closedReject!: (error: unknown) => void

    constructor(private readonly transport: { readable: Readable; writable: Writable }, hooks: CanonicalInvocationHooks) {
        if (!transport?.readable || !transport.writable || !hooks ||
            !['parseCarrier', 'effect', 'verifyResult'].every(k => typeof hooks[k as keyof CanonicalInvocationHooks] === 'function')) {
            throw new ProjectInvocationError('CANONICAL_CHANNEL_NOT_ENABLED', false)
        }
        this.hooks = Object.freeze({ parseCarrier: hooks.parseCarrier.bind(hooks),
            effect: hooks.effect.bind(hooks), verifyResult: hooks.verifyResult.bind(hooks) })
        this.parseCarrier = this.hooks.parseCarrier
        this.ready = new Promise((yes, no) => { this.readyResolve = yes; this.readyReject = no })
        this.closed = new Promise((yes, no) => { this.closedResolve = yes; this.closedReject = no })
        void this.ready.catch(() => {}); void this.closed.catch(() => {})
        transport.readable.on('data', (chunk: Buffer) => this.read(chunk))
        transport.readable.on('error', () => this.poison())
        transport.writable.on('error', () => this.poison())
        transport.readable.on('end', () => { if (!this.closedSeen || this.input.length) this.poison() })
        transport.readable.on('close', () => { if (!this.closedSeen) this.poison() })
    }

    private poison(): void {
        if (this.failed) return
        this.failed = true
        const failure = new ProjectInvocationError('CANONICAL_CHANNEL_LOST_DO_NOT_RETRY', true)
        this.readyReject(failure); this.closedReject(failure)
        for (const pending of this.pending.values()) pending.reject(failure)
        // Never kill a child, release its fence or automatically restart. Python
        // retains a possibly active fence until independent protected drain proof.
    }

    private send(packet: RecordValue): void {
        if (this.failed) throw new ProjectInvocationError('CANONICAL_CHANNEL_UNAVAILABLE', true)
        const wire = Buffer.from(JSON.stringify(packet) + '\n')
        if (wire.length > MAX_FRAME || !this.transport.writable.writable) {
            this.poison()
            throw new ProjectInvocationError('CANONICAL_CHANNEL_UNAVAILABLE', true)
        }
        this.transport.writable.write(wire, error => { if (error) this.poison() })
    }

    private read(chunk: Buffer): void {
        if (this.failed) return
        this.input = Buffer.concat([this.input, chunk])
        try {
            let end: number
            while ((end = this.input.indexOf(10)) !== -1) {
                if (end + 1 > MAX_FRAME) throw new Error('frame limit')
                const wire = this.input.subarray(0, end)
                this.input = this.input.subarray(end + 1)
                this.frame(JSON.parse(wire.toString('utf8')))
            }
            if (this.input.length > MAX_FRAME) throw new Error('frame limit')
        } catch { this.poison() }
    }

    private frame(value: unknown): void {
        if (!value || typeof value !== 'object') throw new Error('invalid frame')
        const packet = value as RecordValue
        if (packet.v !== 1) throw new Error('version')
        if (packet.type === 'ready') {
            exact(packet, ['v', 'type'])
            if (this.readySeen || this.closing) throw new Error('duplicate ready')
            this.readySeen = true; this.readyResolve(); return
        }
        if (packet.type === 'closed') {
            exact(packet, ['v', 'type'])
            if (!this.closing || this.closedSeen || this.pending.size) throw new Error('unexpected close')
            this.closedSeen = true; this.closedResolve(); this.transport.writable.end(); return
        }
        if (!this.readySeen || typeof packet.id !== 'string') throw new Error('missing request')
        const pending = this.pending.get(packet.id)
        if (!pending) throw new Error('unknown request')
        if (packet.type === 'effect') {
            exact(packet, ['v','type','id','target','carrier','association','payload'])
            if (pending.method !== 'invoke' || pending.started || !pending.invoke || !pending.binding ||
                !same(packet.target, pending.target) || !same(packet.association, pending.binding.association) ||
                !same(this.parseCarrier(packet.carrier), pending.binding.carrier)) throw new Error('effect identity')
            const payload = bytes(packet.payload)
            if (digest(payload) !== pending.binding.association.payload_digest) throw new Error('payload identity')
            pending.started = true
            pending.callback = (async () => {
                let open = true, called = false, violation = false
                let callback: Promise<void> | undefined
                const fullReply = (): Promise<void> => {
                    if (!open || called) { violation = true; throw new Error('effect callback closed') }
                    called = true
                    callback = Promise.resolve().then(pending.invoke!)
                    void callback.catch(() => {})
                    return callback
                }
                let result: Uint8Array | undefined, failed = false
                try { result = await this.hooks.effect(pending.binding!, pending.target, payload, fullReply) }
                catch { failed = true }
                finally { open = false }
                try { await callback } catch { failed = true }
                if (!called || violation || !(result instanceof Uint8Array) || result.byteLength > MAX_BYTES) failed = true
                pending.failed = failed; pending.settled = true
                if (failed) {
                    if (!this.failed) this.send({ v: 1, type: 'settled', id: packet.id, ok: false })
                    return
                }
                pending.digest = digest(result!)
                this.send({ v: 1, type: 'settled', id: packet.id,
                    ok: true, result: Buffer.from(result!).toString('base64') })
            })()
            void pending.callback.catch(() => this.poison())
            return
        }
        if (packet.type !== 'response') throw new Error('invalid response')
        if (packet.ok === false) {
            exact(packet, ['v','type','id','ok','unknown','code'])
            if (typeof packet.unknown !== 'boolean' || typeof packet.code !== 'string') throw new Error('invalid error')
            pending.reject(new ProjectInvocationError('CANONICAL_INVOCATION_REJECTED', packet.unknown || pending.started))
        } else {
            exact(packet, ['v','type','id','ok','value'])
            if (packet.ok !== true) throw new Error('invalid success')
            if (pending.method === 'invoke' && (!pending.started || !pending.settled || pending.failed)) throw new Error('early completion')
            pending.resolve(packet.value)
        }
        this.pending.delete(packet.id)
    }

    private async request(method: string, context: Target, binding?: BoundProjectInvocation, invoke?: () => Promise<void>): Promise<unknown> {
        await this.ready
        if (this.failed || this.closing || this.pending.size >= 64 || this.sequence >= 2048) {
            throw new ProjectInvocationError('CANONICAL_CHANNEL_UNAVAILABLE', false)
        }
        const id = `request-${++this.sequence}`
        let resolve!: (value: unknown) => void, reject!: (error: unknown) => void
        const reply = new Promise((yes, no) => { resolve = yes; reject = no })
        void reply.catch(() => {})
        const pending: Pending = { method, target: context, binding, invoke, resolve, reject,
            started: false, settled: false, failed: false }
        this.pending.set(id, pending)
        try {
            this.send({ v: 1, type: 'request', id, method, target: context,
                ...(binding ? { carrier: binding.carrier, association: binding.association } : {}) })
            const result = await reply
            await pending.callback
            if (pending.failed) throw new ProjectInvocationError('CANONICAL_EFFECT_FAILED', pending.started)
            if (method === 'invoke') {
                exact(result, ['status', 'result_digest'])
                if (result.status !== 'COMPLETED' || result.result_digest !== pending.digest) throw new Error('result acknowledgment')
            }
            return result
        } catch (cause) {
            await pending.callback
            throw cause instanceof ProjectInvocationError ? cause
                : new ProjectInvocationError('CANONICAL_PROTOCOL_FAILED', pending.started, { cause })
        } finally { this.pending.delete(id) }
    }

    async resolve(value: Target) {
        const context = target(value)
        const resolved = await this.request('resolve', context)
        exact(resolved, ['carrier', 'association'])
        exact(resolved.association, ['project','request_id','execution_id','payload_digest'])
        const carrier = Object.freeze({ ...this.parseCarrier(resolved.carrier) })
        const association = Object.freeze({ ...resolved.association }) as unknown as BoundProjectInvocation['association']
        if (!Object.values(association).every(v => typeof v === 'string') ||
            association.request_id !== carrier.binding_ref || !/^[0-9a-f]{64}$/.test(association.payload_digest)) {
            throw new ProjectInvocationError('CANONICAL_ASSOCIATION_MISMATCH', false)
        }
        return Object.freeze({ carrier, association })
    }

    async runEffect(binding: BoundProjectInvocation, value: Target, invoke: () => Promise<void>): Promise<void> {
        const context = target(value)
        const snapshot = Object.freeze({ carrier: Object.freeze({ ...this.parseCarrier(binding.carrier) }),
            association: Object.freeze({ ...binding.association }) })
        const result = await this.request('invoke', context, snapshot, invoke) as { result_digest: string }
        this.completed.set(JSON.stringify(context), { binding: snapshot, digest: result.result_digest })
    }

    private async saved(binding: BoundProjectInvocation, context: Target): Promise<Buffer> {
        const result = await this.request('recover', context, binding)
        exact(result, ['status','result','result_digest'])
        const saved = bytes(result.result)
        if (result.status !== 'COMPLETED' || digest(saved) !== result.result_digest) {
            throw new ProjectInvocationError('CANONICAL_RESULT_MISMATCH', true)
        }
        return saved
    }

    /** Explicit protected recovery; never launches an effect or reconnects itself. */
    async recoverResult(binding: BoundProjectInvocation, value: Target): Promise<Uint8Array> {
        const context = target(value), saved = await this.saved(binding, context)
        const accepted = await this.hooks.verifyResult(binding, context, saved)
        if (accepted !== undefined) throw new ProjectInvocationError('INDEPENDENT_VERIFICATION_REQUIRED', true)
        return saved
    }

    async acceptResult(binding: BoundProjectInvocation, value: Target): Promise<void> {
        const context = target(value), key = JSON.stringify(context)
        const completed = this.completed.get(key)
        if (!completed || !same(binding, completed.binding)) throw new ProjectInvocationError('CANONICAL_RESULT_NOT_READY', true)
        const saved = await this.saved(completed.binding, context)
        if (digest(saved) !== completed.digest) throw new ProjectInvocationError('CANONICAL_RESULT_MISMATCH', true)
        const accepted = await this.hooks.verifyResult(completed.binding, context, saved)
        if (accepted !== undefined) throw new ProjectInvocationError('INDEPENDENT_VERIFICATION_REQUIRED', true)
        this.completed.delete(key)
    }

    async close(): Promise<void> {
        await this.ready
        if (!this.closing) { this.closing = true; this.send({ v: 1, type: 'close' }) }
        await this.closed
    }
}
