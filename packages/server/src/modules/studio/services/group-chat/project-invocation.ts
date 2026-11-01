import { AsyncLocalStorage } from 'node:async_hooks'

/** Host-owned ports for the project carrier v1. No transport field grants authority. */
export interface ProjectCarrier {
    readonly version: 1
    readonly binding_ref: string
    readonly binding_digest: string
}

export interface ProjectAssociation {
    readonly project: string
    readonly request_id: string
    readonly execution_id: string
    readonly payload_digest: string
}

export interface ProjectInvocationTarget {
    readonly roomId: string
    readonly messageId: string | null
    readonly agentId: string
    readonly queueId: string | null
}

export interface BoundProjectInvocation {
    readonly carrier: ProjectCarrier
    readonly association: ProjectAssociation
}

/** Inject only from trusted host composition, never Socket.IO data or worker output. */
export interface ProjectInvocationHost {
    /** Current protected lookup. null explicitly selects the existing unbound flow. */
    resolve(target: Readonly<ProjectInvocationTarget>): Promise<{
        carrier: unknown
        association: ProjectAssociation
    } | null>
    /** The canonical project-carrier.mjs parseCarrier, supplied by host composition. */
    parseCarrier(raw: unknown): ProjectCarrier
    /**
     * Resolve fresh authority and run invoke INSIDE the actual service fence.
     * This owns association/provenance, digest/source/executor/epoch checks and
     * a durable invocation ledger. A preflight followed by invoke is insufficient.
     */
    runEffect(binding: BoundProjectInvocation, target: Readonly<ProjectInvocationTarget>, invoke: () => Promise<void>): Promise<void>
    /** Same-request result validation; completion alone is not verification/delivery. */
    acceptResult(binding: BoundProjectInvocation, target: Readonly<ProjectInvocationTarget>): Promise<void>
}

export class ProjectInvocationError extends Error {
    constructor(readonly code: string, readonly outcomeUnknown: boolean, options?: ErrorOptions) {
        super(code, options)
        this.name = 'ProjectInvocationError'
    }
}

interface InvocationScope {
    target: Readonly<ProjectInvocationTarget>
    open: boolean
    attempted: boolean
    invoked: boolean
    failure?: ProjectInvocationError
    effect(operation: () => Promise<void>): Promise<void>
}
const scopes = new AsyncLocalStorage<InvocationScope>()

/** Called at bridge.chat/runAndWait, after all asynchronous launch preparation. */
export async function runProjectInvocationEffect<T>(target: Pick<ProjectInvocationTarget, 'roomId' | 'messageId' | 'agentId'>, operation: () => Promise<T>): Promise<T> {
    const scope = scopes.getStore()
    if (!scope) return operation()
    if (target.roomId !== scope.target.roomId || target.messageId !== scope.target.messageId || target.agentId !== scope.target.agentId) {
        const error = new ProjectInvocationError('INVOCATION_TARGET_MISMATCH', scope.invoked)
        scope.failure = error
        throw error
    }
    if (!scope.open || scope.attempted) {
        const error = new ProjectInvocationError('INVOCATION_CALLBACK_CLOSED', scope.invoked)
        scope.failure = error
        throw error
    }
    scope.attempted = true
    let value!: T
    try {
        await scope.effect(async () => { value = await operation() })
    } catch (error) {
        const failure = error instanceof ProjectInvocationError ? error
            : new ProjectInvocationError('PROJECT_INVOCATION_FAILED', scope.invoked, { cause: error })
        scope.failure = failure
        throw failure
    }
    return value
}

/** Source adapter only. Production composition deliberately installs no host. */
export class ProjectInvocationAdapter {
    constructor(private readonly host: ProjectInvocationHost) {}

    async run(target: ProjectInvocationTarget, operation: () => Promise<void>, supportsEffectBoundary = false): Promise<void> {
        const context = Object.freeze({ ...target })
        const resolved = await this.host.resolve(context)
        if (resolved === null) {
            await scopes.exit(operation)
            return
        }
        // Uninstrumented executors must never start a bound request and only
        // discover their missing final-launch hook after doing external work.
        if (!supportsEffectBoundary) throw new ProjectInvocationError('NOT_ENABLED', false)
        const carrier = Object.freeze({ ...this.host.parseCarrier(resolved.carrier) })
        const association = Object.freeze({ ...resolved.association })
        const binding = Object.freeze({ carrier, association })
        const scope: InvocationScope = {
            target: context, open: true, attempted: false, invoked: false,
            effect: async effect => {
                let open = true
                let protocolViolation = false
                let operationSettled = false
                let pending: Promise<void> | undefined
                let guardError: unknown
                let guardFailed = false
                const invoke = (): Promise<void> => {
                    if (!open || scope.invoked) {
                        protocolViolation = true
                        throw new ProjectInvocationError('INVOCATION_CALLBACK_CLOSED', scope.invoked)
                    }
                    scope.invoked = true
                    try { pending = Promise.resolve(effect()) }
                    catch (error) { pending = Promise.reject(error) }
                    void pending.then(() => { operationSettled = true }, () => { operationSettled = true })
                    return pending
                }
                try { await this.host.runEffect(binding, context, invoke) }
                catch (error) { guardFailed = true; guardError = error }
                finally {
                    open = false
                    if (scope.invoked && !operationSettled) protocolViolation = true
                }
                let operationError: unknown
                let operationFailed = false
                try { await pending }
                catch (error) { operationFailed = true; operationError = error }
                if (guardFailed || operationFailed || protocolViolation) {
                    throw new ProjectInvocationError('PROJECT_INVOCATION_FAILED', scope.invoked, {
                        cause: guardFailed ? guardError : operationError,
                    })
                }
                if (!scope.invoked) throw new ProjectInvocationError('HOST_DID_NOT_INVOKE', false)
            },
        }
        try {
            await scopes.run(scope, operation)
            // Existing reply handlers can catch launch errors while reporting
            // them to the room. Do not upgrade those failures into queue success.
            if (scope.failure) throw scope.failure
            if (!scope.attempted || !scope.invoked) throw new ProjectInvocationError('HOST_DID_NOT_INVOKE', false)
            try { await this.host.acceptResult(binding, context) }
            catch (error) { throw new ProjectInvocationError('RESULT_NOT_ACCEPTED', true, { cause: error }) }
        } catch (error) {
            if (error instanceof ProjectInvocationError) throw error
            throw new ProjectInvocationError('PROJECT_INVOCATION_FAILED', scope.invoked, { cause: error })
        } finally {
            scope.open = false
        }
    }
}
