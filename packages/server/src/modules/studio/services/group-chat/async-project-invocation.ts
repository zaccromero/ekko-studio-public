import { AsyncLocalStorage } from 'node:async_hooks'
import {
    ProjectInvocationAdapter,
    ProjectInvocationError,
    type BoundProjectInvocation,
    type ProjectInvocationHost,
    type ProjectInvocationTarget,
} from './project-invocation'

function deferred<T>() {
    let settled = false
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    // A fence can reject before its consumer reaches the corresponding await.
    void promise.catch(() => {})
    return {
        promise,
        get settled() { return settled },
        resolve(value: T) { if (!settled) { settled = true; resolve(value) } },
        reject(error: unknown) { if (!settled) { settled = true; reject(error) } },
    }
}

type Lifecycle = {
    target: Readonly<ProjectInvocationTarget>
    open: boolean
    attempted: boolean
    started: boolean
    callbackSettled: boolean
    aborted: boolean
    failed: boolean
    failure?: unknown
    launch: ReturnType<typeof deferred<void>>
    completion: ReturnType<typeof deferred<void>>
    servicePending?: Promise<void>
    callbackPending?: Promise<void>
}

function fail(state: Lifecycle, error: unknown): void {
    if (!state.failed) { state.failed = true; state.failure = error }
}

function error(code: string, state: Lifecycle, cause?: unknown): ProjectInvocationError {
    return new ProjectInvocationError(code, state.started, { cause })
}

function sameTarget(a: Readonly<ProjectInvocationTarget>, b: Readonly<ProjectInvocationTarget>): boolean {
    return a.roomId === b.roomId && a.messageId === b.messageId && a.agentId === b.agentId && a.queueId === b.queueId
}

/**
 * Opt-in composition of the existing final-launch adapter with a host-owned
 * canonical service. Its async effect callback remains pending until the full
 * reply completes, so bridge.chat returning a run ID does not release the fence.
 *
 * The injected service must supply real provenance, permission checks, durable
 * invocation deduplication and external sub-effect fencing. This coordinator is
 * not that service, a second ledger, or a qualification/permission token.
 */
export class AsyncProjectInvocationAdapter extends ProjectInvocationAdapter {
    private readonly lifecycles: AsyncLocalStorage<Lifecycle>

    constructor(service: ProjectInvocationHost) {
        if (!service || !(['resolve', 'parseCarrier', 'runEffect', 'acceptResult'] as const)
            .every(key => typeof service[key] === 'function')) {
            throw new ProjectInvocationError('NOT_ENABLED', false)
        }
        // Capture fixed protected host methods; task/message JSON never selects them.
        const ports = Object.freeze({
            resolve: service.resolve.bind(service),
            parseCarrier: service.parseCarrier.bind(service),
            runEffect: service.runEffect.bind(service),
            acceptResult: service.acceptResult.bind(service),
        })
        const lifecycles = new AsyncLocalStorage<Lifecycle>()
        const current = (target: Readonly<ProjectInvocationTarget>): Lifecycle => {
            const state = lifecycles.getStore()
            if (!state || !state.open || !sameTarget(state.target, target)) {
                throw new ProjectInvocationError('INVOCATION_TARGET_MISMATCH', state?.started ?? false)
            }
            return state
        }
        const host: ProjectInvocationHost = {
            resolve: async target => {
                const state = current(target)
                if (state.aborted) throw error('PROJECT_INVOCATION_ABORTED', state)
                const resolved = await ports.resolve(target)
                // This factory is bound-only. The original unbound singleton is unchanged.
                if (resolved === null) throw new ProjectInvocationError('NOT_ENABLED', false)
                return resolved
            },
            parseCarrier: ports.parseCarrier,
            runEffect: async (binding, target, invoke) => {
                const state = current(target)
                if (state.aborted) throw error('PROJECT_INVOCATION_ABORTED', state)
                if (state.attempted) throw error('INVOCATION_CALLBACK_CLOSED', state)
                state.attempted = true
                let callbackOpen = true
                const fullReply = (): Promise<void> => {
                    if (!callbackOpen || state.started || !state.open) {
                        const rejection = error('INVOCATION_CALLBACK_CLOSED', state)
                        fail(state, rejection)
                        throw rejection
                    }
                    if (state.aborted || state.failed) {
                        const rejection = state.failed ? state.failure : error('PROJECT_INVOCATION_ABORTED', state)
                        fail(state, rejection)
                        throw rejection
                    }
                    state.started = true
                    state.callbackPending = (async () => {
                        try {
                            // The old adapter still owns exactly-once final-launch protocol.
                            await invoke()
                            state.launch.resolve()
                            // Keep the SAME canonical service fence through async streaming.
                            await state.completion.promise
                        } catch (cause) {
                            fail(state, cause)
                            state.launch.reject(cause)
                            throw cause
                        } finally { state.callbackSettled = true }
                    })()
                    void state.callbackPending.catch(() => {})
                    return state.callbackPending
                }
                state.servicePending = (async () => {
                    try { await ports.runEffect(binding, target, fullReply) }
                    catch (cause) {
                        fail(state, cause)
                        state.launch.reject(cause)
                        throw cause
                    } finally {
                        callbackOpen = false
                        if (!state.started || !state.completion.settled || !state.callbackSettled) {
                            const rejection = error(state.started ? 'ASYNC_FENCE_RETURNED_EARLY' : 'HOST_DID_NOT_INVOKE', state)
                            fail(state, rejection)
                            state.launch.reject(rejection)
                        }
                    }
                    // A backend cannot turn a swallowed callback error into success.
                    if (state.failed) throw state.failure
                })()
                void state.servicePending.catch(() => {})
                await state.launch.promise
                if (state.failed) throw state.failure
            },
            acceptResult: async (binding: BoundProjectInvocation, target) => {
                const state = current(target)
                if (!state.started || !state.servicePending) throw error('HOST_DID_NOT_INVOKE', state)
                if (state.failed) state.completion.reject(state.failure)
                else if (state.aborted) state.completion.reject(error('PROJECT_INVOCATION_ABORTED', state))
                else state.completion.resolve()
                // Saved completion/fence exit must be acknowledged before result verification.
                await state.servicePending
                await state.callbackPending
                if (state.failed) throw state.failure
                await ports.acceptResult(binding, target)
            },
        }
        super(host)
        this.lifecycles = lifecycles
    }

    override async run(target: ProjectInvocationTarget, operation: () => Promise<void>, supportsEffectBoundary = false, signal?: AbortSignal): Promise<void> {
        const context = Object.freeze({ ...target })
        if (![context.roomId, context.messageId, context.agentId, context.queueId]
            .every(value => typeof value === 'string' && value.length > 0 && value.length <= 160)) {
            throw new ProjectInvocationError('VERIFIED_FULL_TARGET_REQUIRED', false)
        }
        const state: Lifecycle = {
            target: context, open: true, attempted: false, started: false,
            callbackSettled: false, aborted: signal?.aborted ?? false,
            failed: false, launch: deferred<void>(), completion: deferred<void>(),
        }
        // Cancellation is not permission to detach, release the fence or retry.
        // The actual executor owns stopping its run; we await its settlement.
        const onAbort = () => { state.aborted = true }
        signal?.addEventListener('abort', onAbort, { once: true })
        return this.lifecycles.run(state, async () => {
            let failed = false
            let cause: unknown
            try {
                if (state.aborted) throw error('PROJECT_INVOCATION_ABORTED', state)
                await super.run(context, operation, supportsEffectBoundary)
            } catch (caught) { failed = true; cause = caught }
            finally {
                state.open = false
                if (!state.completion.settled) {
                    state.completion.reject(failed ? cause : error('ASYNC_REPLY_NOT_COMPLETED', state))
                }
                // Even a broken backend cannot make an already-started callback vanish.
                const outcomes = await Promise.allSettled([
                    ...(state.servicePending ? [state.servicePending] : []),
                    ...(state.callbackPending ? [state.callbackPending] : []),
                ])
                for (const outcome of outcomes) {
                    if (outcome.status === 'rejected') fail(state, outcome.reason)
                }
                signal?.removeEventListener('abort', onAbort)
            }
            if (failed) throw cause
            if (state.failed) throw error('PROJECT_INVOCATION_FAILED', state, state.failure)
            if (state.aborted) throw error('PROJECT_INVOCATION_ABORTED', state)
        })
    }
}
