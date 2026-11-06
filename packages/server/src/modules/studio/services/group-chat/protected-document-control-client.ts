import { TextDecoder } from 'node:util'
import type { Readable, Writable } from 'node:stream'
import { ProjectInvocationError, type BoundProjectInvocation, type ProjectInvocationTarget } from './project-invocation'

const PROTOCOL = 'protected-document-control.v1'
const MAX_FRAME = 16384
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const HASH = /^[0-9a-f]{64}$/
const PROJECTS = new Set(['gym-nyc','milo','syr','drako-os','content-studio','mora-cafe','zacc-ai','azael'])
type ObjectValue = Record<string, unknown>
type Route = Readonly<Required<ProjectInvocationTarget>>
export type PrivateCapture = Readonly<{
    status: 'PRIVATE_CAPTURED'; result_digest: string; verified: false; publication: 'NOT_RUN'
}>
export type LocalPublication = Readonly<{
    status: 'PUBLISHED'; result_digest: string; publication_id: string;
    publication_scope: 'local-documentation-file'; replayed: false
}>
export type SavedDocument = Readonly<{
    status: 'PRIVATE_RESULT' | 'UNKNOWN'; result_digest: string;
    publication: 'NOT_RUN' | 'UNKNOWN'; replayed: false
}>
type Result = PrivateCapture | LocalPublication | SavedDocument
type Pending = {
    method: string; digest?: string; abort?: () => void; signal?: AbortSignal;
    resolve(value: Result): void; reject(error: Error): void
}

function exact(value: unknown, keys: string[]): asserts value is ObjectValue {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('invalid fields')
}
function hash(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !HASH.test(value)) throw new Error('invalid digest')
}

/** Proposed opt-in metadata-only client, NOT a ProjectInvocationHost adapter.
 * It cannot call AgentClient, supply model input or accept an executor callback.
 * A protected host independently supplies the immutable route/binding and owns
 * both pipe ends. drained() must prove the Python control/factory has returned;
 * a stream closing, socket ACK or promise resolving alone is not that proof.
 */
export class ProtectedDocumentControlClient {
    private readonly route: Route
    private readonly binding: BoundProjectInvocation
    private readonly pending = new Map<string, Pending>()
    private readonly decoder = new TextDecoder('utf-8', { fatal: true })
    private buffer = Buffer.alloc(0)
    private sequence = 0
    private failed = false
    private closing = false
    private closed?: Promise<void>

    constructor(private readonly transport: { readable: Readable; writable: Writable; drained(): Promise<void> },
        target: ProjectInvocationTarget, binding: BoundProjectInvocation) {
        try {
            if (!transport?.readable || !transport.writable || typeof transport.drained !== 'function') throw new Error('missing host port')
            exact(target, ['roomId','messageId','agentId','queueId'])
            if (!Object.values(target).every(v => typeof v === 'string' && ID.test(v))) throw new Error('full target required')
            exact(binding, ['carrier','association'])
            exact(binding.carrier, ['version','binding_ref','binding_digest'])
            exact(binding.association, ['project','request_id','execution_id','payload_digest'])
            const c = binding.carrier, a = binding.association
            if (c.version !== 1 || typeof c.binding_ref !== 'string' || !ID.test(c.binding_ref) ||
                !PROJECTS.has(a.project) || a.request_id !== c.binding_ref || !ID.test(a.execution_id)) throw new Error('binding required')
            hash(c.binding_digest);hash(a.payload_digest)
            this.route = Object.freeze({ ...target }) as Route
            this.binding = Object.freeze({ carrier: Object.freeze({ ...c }), association: Object.freeze({ ...a }) })
        } catch { throw new ProjectInvocationError('PROTECTED_DOCUMENT_CHANNEL_NOT_ENABLED', false) }
        transport.readable.on('data', chunk => this.read(Buffer.from(chunk)))
        transport.readable.on('error', () => this.poison())
        transport.readable.on('end', () => this.poison())
        transport.readable.on('close', () => this.poison())
        transport.writable.on('error', () => this.poison())
    }

    private poison(): void {
        if (this.failed) return
        this.failed = true
        for (const [id, pending] of this.pending) {
            this.pending.delete(id)
            if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort)
            pending.reject(new ProjectInvocationError('PROTECTED_DOCUMENT_OUTCOME_UNKNOWN_NO_RETRY', true))
        }
        // Never kill/restart the protected executor, replay work or clear a claim.
    }

    private send(packet: ObjectValue): void {
        if (this.failed || !this.transport.writable.writable) throw new Error('closed channel')
        const wire = Buffer.from(JSON.stringify(packet)+'\n')
        if (wire.length > MAX_FRAME) throw new Error('frame limit')
        // Admission bounds also bound queued control bytes; no document payload.
        this.transport.writable.write(wire, error => { if (error) this.poison() })
    }

    private read(chunk: Buffer): void {
        if (this.failed) return
        // Reject an oversized transport chunk before concatenation as well.
        if (chunk.length > MAX_FRAME * 8) { this.poison();return }
        this.buffer = Buffer.concat([this.buffer, chunk])
        try {
            let end: number
            while ((end = this.buffer.indexOf(10)) !== -1) {
                if (end > MAX_FRAME) throw new Error('frame limit')
                const wire = this.decoder.decode(this.buffer.subarray(0, end))
                this.buffer = this.buffer.subarray(end+1)
                const packet: unknown = JSON.parse(wire)
                // The Python endpoint emits compact ASCII metadata. Requiring
                // that encoding rejects duplicate keys rather than normalizing.
                if (JSON.stringify(packet) !== wire) throw new Error('noncanonical frame')
                this.frame(packet)
            }
            if (this.buffer.length > MAX_FRAME) throw new Error('frame limit')
        } catch { this.poison() }
    }

    private frame(packet: unknown): void {
        if (!packet || typeof packet !== 'object') throw new Error('invalid response')
        const value = packet as ObjectValue
        exact(value, ['protocol','type','id', 'error' in value ? 'error' : 'result'])
        if (value.protocol !== PROTOCOL || value.type !== 'response' || typeof value.id !== 'string') throw new Error('invalid response')
        const pending = this.pending.get(value.id)
        if (!pending) throw new Error('unknown response')
        if ('error' in value) {
            exact(value.error, ['status','code'])
            if (!((value.error.status === 'HELD' && value.error.code === 'CONTROL_REJECTED') ||
                  (value.error.status === 'UNKNOWN' && value.error.code === 'RECONCILE_REQUIRED'))) throw new Error('invalid rejection')
            this.pending.delete(value.id)
            if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort)
            pending.reject(new ProjectInvocationError('PROTECTED_DOCUMENT_CONTROL_REJECTED', value.error.status === 'UNKNOWN'))
            return
        }
        const result = value.result as ObjectValue
        if (!result || typeof result !== 'object') throw new Error('invalid result')
        hash(result.result_digest)
        if (pending.digest !== undefined && result.result_digest !== pending.digest) throw new Error('digest mismatch')
        if (result.status === 'PRIVATE_CAPTURED') {
            exact(result, ['status','result_digest','verified','publication'])
            if (pending.method !== 'execute_privately' || result.verified !== false || result.publication !== 'NOT_RUN') throw new Error('invalid capture')
        } else if (result.status === 'PUBLISHED') {
            exact(result, ['status','result_digest','publication_id','publication_scope','replayed'])
            if (!['publish_document','recover'].includes(pending.method) || typeof result.publication_id !== 'string' ||
                !ID.test(result.publication_id) || result.publication_scope !== 'local-documentation-file' || result.replayed !== false) throw new Error('invalid publication')
        } else {
            exact(result, ['status','result_digest','replayed','publication'])
            if (pending.method !== 'recover' || result.replayed !== false ||
                !((result.status === 'PRIVATE_RESULT' && result.publication === 'NOT_RUN') ||
                  (result.status === 'UNKNOWN' && result.publication === 'UNKNOWN'))) throw new Error('invalid recovery')
        }
        this.pending.delete(value.id)
        if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort)
        pending.resolve(Object.freeze({ ...result }) as Result)
    }

    private request(method: string, digest?: string, signal?: AbortSignal): Promise<Result> {
        if (this.failed || this.closing || this.pending.size >= 8 || this.sequence >= 1024 || signal?.aborted) {
            return Promise.reject(new ProjectInvocationError('PROTECTED_DOCUMENT_NOT_ADMITTED', false))
        }
        if (digest !== undefined) {
            try { hash(digest) } catch { return Promise.reject(new ProjectInvocationError('PROTECTED_DOCUMENT_INVALID_DIGEST', false)) }
        }
        const id = `document-${++this.sequence}`
        return new Promise((resolve, reject) => {
            const pending: Pending = { method, digest, resolve, reject, signal }
            pending.abort = () => {
                try { this.send({ protocol: PROTOCOL, type: 'cancel', id }) } catch { this.poison() }
                // Await the original response/host drain, never detach/retry.
            }
            this.pending.set(id, pending)
            try {
                this.send({ protocol: PROTOCOL, type: 'request', id, method,
                    target: this.route, ...this.binding, ...(digest === undefined ? {} : { result_digest: digest }) })
                signal?.addEventListener('abort', pending.abort, { once: true })
                if (signal?.aborted) pending.abort()
            } catch { this.poison() }
        })
    }

    async executePrivately(signal?: AbortSignal): Promise<PrivateCapture> {
        return await this.request('execute_privately', undefined, signal) as PrivateCapture
    }
    async publishDocument(digest: string, signal?: AbortSignal): Promise<LocalPublication> {
        return await this.request('publish_document', digest, signal) as LocalPublication
    }
    async recover(digest?: string, signal?: AbortSignal): Promise<LocalPublication | SavedDocument> {
        return await this.request('recover', digest, signal) as LocalPublication | SavedDocument
    }

    close(): Promise<void> {
        if (!this.closed) {
            this.closing = true
            this.closed = (async () => {
                this.transport.writable.end()
                try { await this.transport.drained() }
                finally { this.poison() }
            })()
        }
        return this.closed
    }
}
