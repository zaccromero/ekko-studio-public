import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { AgentClient, type AgentConfig, type GroupAgentEventSink } from './agent-clients'
import { AsyncProjectInvocationAdapter } from './async-project-invocation'
import { CanonicalProjectInvocationHost, type CanonicalInvocationHooks } from './canonical-project-invocation'
import { ProjectInvocationError, type BoundProjectInvocation, type ProjectInvocationTarget } from './project-invocation'

type Target = Readonly<ProjectInvocationTarget>
export interface ProjectPublicationReceipt {
    status: 'PUBLISHED'
    publicationId: string
    manifestDigest: string
    target: Target
}
/** Fixed protected host port. It MUST reauthorize and durably fence the entire
 * publication, including its external effects, against this exact binding.
 * No automatic replay, per-packet fallback, or room-supplied publisher.
 */
export interface ProjectPublisher {
    publish(binding: BoundProjectInvocation, target: Target, manifest: string): Promise<ProjectPublicationReceipt>
}
export type PublicationHooks = Pick<CanonicalInvocationHooks, 'parseCarrier' | 'verifyResult'> & {
    effect(binding: BoundProjectInvocation, target: Target, approvedPayload: Uint8Array, invoke: () => Promise<void>): Promise<void>
}
type State = {
    target: Target
    phase: 'capturing' | 'sealed' | 'publishing' | 'closed'
    events: unknown[]
    bytes: number
    started: boolean
    verified: boolean
    binding?: BoundProjectInvocation
    manifest?: string
    failure?: ProjectInvocationError
}
const MAX_BYTES = 1024 * 1024
const MAX_EVENTS = 2048
const EVENTS = new Set(['typing', 'stop_typing', 'context_status', 'message_stream_start',
    'message_stream_delta', 'message_reasoning_delta', 'message_stream_end'])
const key = (t: Target) => JSON.stringify([t.roomId, t.messageId, t.agentId, t.queueId])
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const equalTarget = (a: Target, b: Target) => a.roomId === b.roomId && a.messageId === b.messageId && a.agentId === b.agentId && a.queueId === b.queueId

// Copy JSON data without invoking toJSON/getters or dropping executable values.
// Optional undefined object properties follow the normal JSON wire semantics.
function jsonCopy(value: unknown, depth = 0, budget = { bytes: 0, nodes: 0 }): any {
    if (depth > 20) throw new Error('publication depth limit')
    if (++budget.nodes > 8192) throw new Error('publication node limit')
    if (typeof value === 'string') {
        budget.bytes += Buffer.byteLength(value)
        if (budget.bytes > MAX_BYTES) throw new Error('publication byte limit')
        return value
    }
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (Array.isArray(value)) {
        if (value.length > 8192) throw new Error('publication array limit')
        const descriptors = Object.getOwnPropertyDescriptors(value)
        return Array.from({ length: value.length }, (_, i) => {
            const descriptor = descriptors[String(i)]
            if (descriptor && !('value' in descriptor)) throw new Error('publication accessor rejected')
            return jsonCopy(descriptor?.value ?? null, depth + 1, budget)
        })
    }
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('JSON publication data required')
    const result = Object.create(null)
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable) continue
        if (!('value' in descriptor)) throw new Error('publication accessor rejected')
        budget.bytes += Buffer.byteLength(name)
        if (budget.bytes > MAX_BYTES) throw new Error('publication byte limit')
        if (descriptor.value !== undefined) result[name] = jsonCopy(descriptor.value, depth + 1, budget)
    }
    return result
}
function reject(state: State, code: string): never {
    state.failure ||= new ProjectInvocationError(code, state.started)
    throw state.failure
}

/** Source-only noninteractive composition. Existing factories remain unchanged. */
export class VerifiedProjectPublication extends AsyncProjectInvocationAdapter {
    private readonly channel: CanonicalProjectInvocationHost
    private readonly context: AsyncLocalStorage<State>
    private readonly states: Map<string, State>
    private readonly seen = new Set<string>()
    private readonly publish: ProjectPublisher['publish']
    private readonly operations = new Set<Promise<void>>()
    private closing = false
    private closePending?: Promise<void>

    constructor(transport: { readable: Readable; writable: Writable }, hooks: PublicationHooks, publisher: ProjectPublisher) {
        if (!hooks || !['parseCarrier', 'effect', 'verifyResult'].every(k => typeof hooks[k as keyof PublicationHooks] === 'function') || typeof publisher?.publish !== 'function') {
            throw new ProjectInvocationError('VERIFIED_PUBLICATION_NOT_ENABLED', false)
        }
        const states = new Map<string, State>(), context = new AsyncLocalStorage<State>()
        const ports = Object.freeze({ parseCarrier: hooks.parseCarrier.bind(hooks), effect: hooks.effect.bind(hooks), verifyResult: hooks.verifyResult.bind(hooks) })
        const current = (target: Target) => {
            const state = states.get(key(target))
            if (!state || state.phase === 'closed' || !equalTarget(state.target, target)) throw new ProjectInvocationError('PUBLICATION_TARGET_MISMATCH', true)
            if (state.failure) throw state.failure
            return state
        }
        const channel = new CanonicalProjectInvocationHost(transport, {
            parseCarrier: ports.parseCarrier,
            effect: async (binding, target, payload, invoke) => {
                const state = current(target)
                state.binding = Object.freeze({ carrier: Object.freeze({ ...binding.carrier }), association: Object.freeze({ ...binding.association }) })
                let settled = false
                // Transport data handlers can originate outside run()'s async
                // resources. Restore THIS matched target's context before any
                // hook/executor creates asynchronous streaming callbacks.
                const result = await context.run(state, () => ports.effect(state.binding!, state.target, payload, async () => {
                    state.started = true
                    await invoke()
                    settled = true
                }))
                if (result !== undefined || !settled) reject(state, 'PUBLICATION_EFFECT_NOT_SETTLED')
                if (state.failure) throw state.failure
                state.phase = 'sealed'
                const manifest = JSON.stringify({ version: 1, binding: state.binding, target: state.target, events: state.events })
                if (Buffer.byteLength(manifest) > MAX_BYTES) reject(state, 'PUBLICATION_BYTES_EXCEEDED')
                state.manifest = manifest
                return Buffer.from(manifest)
            },
            verifyResult: async (binding, target, saved) => {
                const state = current(target)
                if (state.phase !== 'sealed' || !state.manifest || !state.binding ||
                    !Buffer.from(saved).equals(Buffer.from(state.manifest)) ||
                    JSON.stringify(binding) !== JSON.stringify(state.binding)) reject(state, 'PUBLICATION_SAVED_RESULT_MISMATCH')
                const result = await ports.verifyResult(state.binding, state.target, Buffer.from(saved))
                if (result !== undefined || state.failure) reject(state, 'PUBLICATION_RESULT_NOT_VERIFIED')
                state.verified = true
            },
        })
        super(channel)
        this.channel = channel; this.states = states; this.context = context
        this.publish = publisher.publish.bind(publisher)
    }

    /** Actual AgentClient send/emit path; no socket, fallback, or external ACK. */
    createCapturedAgent(config: AgentConfig): AgentClient {
        const agentId = config.agentId || randomUUID()
        let connected = true
        const capture = (roomId: string, value: unknown) => {
            const state = this.context.getStore()
            if (!state) throw new ProjectInvocationError('PUBLICATION_SCOPE_REQUIRED', false)
            if (!connected || state.phase !== 'capturing' || state.target.roomId !== roomId || state.target.agentId !== agentId) reject(state, 'PUBLICATION_SCOPE_MISMATCH')
            if (state.failure) throw state.failure
            try {
                const copied = jsonCopy(value), bytes = Buffer.byteLength(JSON.stringify(copied))
                if (state.events.length >= MAX_EVENTS || state.bytes + bytes > MAX_BYTES) reject(state, 'PUBLICATION_CAPTURE_LIMIT')
                state.events.push(copied); state.bytes += bytes
            } catch (error) {
                if (error instanceof ProjectInvocationError) throw error
                reject(state, 'INVALID_PUBLICATION_JSON')
            }
        }
        const sink: GroupAgentEventSink = {
            get connected() { return connected }, id: agentId,
            sendMessage: async (roomId, content, messageId, extra, agentSessionId) => {
                const id = messageId || randomUUID()
                capture(roomId, { kind: 'message', roomId, content, messageId: id, extra, agentSessionId })
                return id // Private staging ACK only; never persistence/delivery.
            },
            emit: (event, payload) => {
                const state = this.context.getStore()
                if (!state) throw new ProjectInvocationError('PUBLICATION_SCOPE_REQUIRED', false)
                if (!EVENTS.has(event)) reject(state, 'INTERACTIVE_OR_UNKNOWN_PUBLICATION_EVENT')
                capture(typeof payload.roomId === 'string' ? payload.roomId : '', { kind: 'event', event, payload })
            },
            disconnect: () => { connected = false },
        }
        const context = this.context, states = this.states
        const stageWorkspaceDiff = (args: unknown) => {
            const state = context.getStore()
            if (!state) {
                // An out-of-context interrupt/finalizer must not silently drop
                // its diff and let an active invocation claim successful delivery.
                for (const active of states.values()) {
                    if (active.target.agentId === agentId) active.failure ||= new ProjectInvocationError('PUBLICATION_SCOPE_REQUIRED', active.started)
                }
                throw new ProjectInvocationError('PUBLICATION_SCOPE_REQUIRED', false)
            }
            try {
                const copied = jsonCopy(args)
                if (!copied || copied.senderId !== agentId || copied.roomId !== state.target.roomId) reject(state, 'PUBLICATION_SCOPE_MISMATCH')
                capture(copied.roomId, { kind: 'workspace_diff', args: copied })
                return null // Private capture only; no gc_messages write or broadcast.
            } catch (error) {
                if (error instanceof ProjectInvocationError) throw error
                reject(state, 'INVALID_PUBLICATION_JSON')
            }
        }
        class CapturedAgentClient extends AgentClient {
            override setStorage(storage: any): void {
                if (!storage) { super.setStorage(storage); return }
                // Pass only existing read/identity-metadata methods. In
                // particular, never expose the live workspace publication writer.
                const staged = Object.create(null)
                for (const method of ['getRoom', 'getRoomAgents', 'getRoomMembers', 'getMentionableRoomAgents',
                    'getMemberByUserId', 'registerTrustedAgentMessageMetadata']) {
                    if (typeof storage[method] === 'function') staged[method] = storage[method].bind(storage)
                }
                staged.saveWorkspaceDiffMessageForRun = stageWorkspaceDiff
                super.setStorage(Object.freeze(staged))
            }
        }
        return new CapturedAgentClient({ ...config, agentId }, {}, sink)
    }

    override async run(target: ProjectInvocationTarget, operation: () => Promise<void>, supportsEffectBoundary = false, signal?: AbortSignal): Promise<void> {
        const frozen = Object.freeze({ ...target }), identity = key(frozen)
        if (this.closing || this.seen.has(identity) || this.seen.size >= 2048 || this.states.size >= 64) throw new ProjectInvocationError('PUBLICATION_IDENTITY_ALREADY_USED_OR_LIMIT', false)
        this.seen.add(identity)
        const state: State = { target: frozen, phase: 'capturing', events: [], bytes: 0, started: false, verified: false }
        this.states.set(identity, state)
        const pending = this.context.run(state, async () => {
            try {
                await super.run(frozen, operation, supportsEffectBoundary, signal)
                if (state.failure) throw state.failure
                if (!state.verified || !state.manifest || !state.binding) reject(state, 'PUBLICATION_RESULT_NOT_VERIFIED')
                if (signal?.aborted) reject(state, 'PUBLICATION_ABORTED')
                state.phase = 'publishing'
                try {
                    const receipt = await this.publish(state.binding, frozen, state.manifest)
                    if (!receipt || Object.keys(receipt).sort().join(',') !== 'manifestDigest,publicationId,status,target' ||
                        receipt.status !== 'PUBLISHED' || typeof receipt.publicationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(receipt.publicationId) ||
                        receipt.manifestDigest !== digest(state.manifest) || !receipt.target || !equalTarget(receipt.target, frozen) ||
                        Object.keys(receipt.target).sort().join(',') !== 'agentId,messageId,queueId,roomId' || state.failure || signal?.aborted) throw new Error('publication receipt mismatch or cancellation')
                } catch (cause) {
                    throw new ProjectInvocationError('PUBLICATION_UNKNOWN_DO_NOT_RETRY', true, { cause })
                }
            } finally {
                state.phase = 'closed'; state.events.length = 0
                this.states.delete(identity)
            }
        })
        this.operations.add(pending)
        try { await pending } finally { this.operations.delete(pending) }
    }

    /** Reject new admissions, drain execution AND publication, then close channel.
     * No process kill or implicit publisher/executor cancellation.
     */
    close(): Promise<void> {
        if (!this.closePending) {
            this.closing = true
            this.closePending = (async () => {
                await Promise.allSettled([...this.operations])
                await this.channel.close()
            })()
        }
        return this.closePending
    }
}
