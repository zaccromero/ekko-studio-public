import { describe, expect, it, vi } from 'vitest'
import { AsyncProjectInvocationAdapter } from '../../packages/server/src/modules/studio/services/group-chat/async-project-invocation'
import { createProtectedProjectAgentClients } from '../../packages/server/src/bootstrap/project-invocation'
import { runProjectInvocationEffect, type ProjectInvocationHost, type ProjectInvocationTarget } from '../../packages/server/src/modules/studio/services/group-chat/project-invocation'

const target = { roomId: 'room-1', messageId: 'message-1', agentId: 'agent-1', queueId: 'queue-1' }
const carrier = { version: 1 as const, binding_ref: 'protected-request', binding_digest: 'a'.repeat(64) }
const association = { project: 'gym-nyc', request_id: 'request-1', execution_id: 'execution-1', payload_digest: 'b'.repeat(64) }
function deferred<T = void>() {
    let resolve!: (value: T) => void
    let reject!: (cause: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
function fixture(overrides: Partial<ProjectInvocationHost> = {}) {
    const events: string[] = []
    const active = new Set<string>()
    let revoked = false
    const records = new Map([
        ['queue-1', { target, binding: { carrier, association } }],
        ['queue-2', { target: { ...target, messageId: 'message-2', queueId: 'queue-2' }, binding: { carrier: { ...carrier, binding_ref: 'protected-request-2' }, association: { ...association, request_id: 'request-2', execution_id: 'execution-2' } } }],
    ])
    const service: ProjectInvocationHost = {
        resolve: vi.fn(async context => {
            const record = records.get(context.queueId!)
            if (!record) throw new Error('NOT_ENABLED')
            expect(context).toEqual(record.target)
            return record.binding
        }),
        // Protocol fixture only; production injects the canonical parser and authority service.
        parseCarrier: vi.fn(raw => raw as typeof carrier),
        runEffect: vi.fn(async (binding, context, invoke) => {
            if (revoked) throw new Error('REVOKED')
            expect(binding).toEqual(records.get(context.queueId!)!.binding)
            expect(Object.isFrozen(binding.carrier)).toBe(true)
            expect(Object.isFrozen(binding.association)).toBe(true)
            active.add(context.queueId!)
            events.push('fence-enter:'+context.queueId)
            try { await invoke() }
            finally { active.delete(context.queueId!); events.push('fence-exit:'+context.queueId) }
        }),
        acceptResult: vi.fn(async (_binding, context) => {
            expect(active.has(context.queueId!)).toBe(false)
            events.push('verify:'+context.queueId)
        }),
        ...overrides,
    }
    return { service, events, active, revoke: () => { revoked = true } }
}
function run(adapter: AsyncProjectInvocationAdapter, effect: () => Promise<unknown>, tail: () => Promise<void> = async () => {}, context = target, signal?: AbortSignal) {
    return adapter.run(context, async () => {
        await runProjectInvocationEffect(context, effect)
        await tail()
    }, true, signal)
}

describe('full async reply under the existing canonical service port', () => {
    it('keeps the fence open after bridge.chat launch and awaits the full reply before verifying', async () => {
        const f = fixture(); const adapter = new AsyncProjectInvocationAdapter(f.service)
        const tail = deferred(); let settled = false
        const running = run(adapter, async () => {
            expect(f.active.has(target.queueId)).toBe(true)
            f.events.push('launch')
            return { run_id: 'native-run' }
        }, async () => {
            expect(f.active.has(target.queueId)).toBe(true)
            f.events.push('stream-start'); await tail.promise
            expect(f.active.has(target.queueId)).toBe(true)
            f.events.push('reply-complete')
        }).then(() => { settled = true })
        await vi.waitFor(() => expect(f.events).toContain('stream-start'))
        expect(settled).toBe(false); expect(f.service.acceptResult).not.toHaveBeenCalled()
        tail.resolve(); await running
        expect(f.events).toEqual(['fence-enter:queue-1','launch','stream-start','reply-complete','fence-exit:queue-1','verify:queue-1'])
    })

    it('does not invoke or verify after late revocation during async preparation', async () => {
        const f = fixture(); const prepare = deferred(); const effect = vi.fn(async () => {})
        const adapter = new AsyncProjectInvocationAdapter(f.service)
        const running = adapter.run(target, async () => { await prepare.promise; await runProjectInvocationEffect(target,effect) },true)
        await vi.waitFor(() => expect(f.service.resolve).toHaveBeenCalledOnce())
        f.revoke(); prepare.resolve()
        await expect(running).rejects.toMatchObject({ outcomeUnknown:false })
        expect(effect).not.toHaveBeenCalled(); expect(f.service.acceptResult).not.toHaveBeenCalled()
    })

    it.each(['messageId','queueId'] as const)('requires a full protected target (%s)', async key => {
        const f = fixture(); const adapter = new AsyncProjectInvocationAdapter(f.service)
        for (const value of [null,'']) {
            await expect(adapter.run({ ...target,[key]:value },async () => {},true)).rejects.toMatchObject({ code:'VERIFIED_FULL_TARGET_REQUIRED',outcomeUnknown:false })
        }
        expect(f.service.resolve).not.toHaveBeenCalled()
    })

    it('holds absent host and protected null routing instead of falling back to unbound dispatch', async () => {
        expect(() => new AsyncProjectInvocationAdapter(undefined as unknown as ProjectInvocationHost)).toThrow('NOT_ENABLED')
        const f = fixture({ resolve:async () => null }); const effect = vi.fn(async () => {})
        await expect(run(new AsyncProjectInvocationAdapter(f.service),effect)).rejects.toMatchObject({ code:'NOT_ENABLED',outcomeUnknown:false })
        expect(effect).not.toHaveBeenCalled(); expect(f.service.runEffect).not.toHaveBeenCalled()
    })

    it('uses the injected canonical parser and rejects malformed carriers before launch', async () => {
        const f = fixture({ parseCarrier:() => { throw new Error('CANONICAL_CARRIER_REJECTED') } }); const effect = vi.fn(async () => {})
        await expect(run(new AsyncProjectInvocationAdapter(f.service),effect)).rejects.toThrow('CANONICAL_CARRIER_REJECTED')
        expect(effect).not.toHaveBeenCalled(); expect(f.service.runEffect).not.toHaveBeenCalled()
    })

    it('rejects an executor without the existing final-effect boundary before it starts', async () => {
        const f = fixture(); const operation = vi.fn(async () => {})
        await expect(new AsyncProjectInvocationAdapter(f.service).run(target,operation)).rejects.toMatchObject({ code:'NOT_ENABLED',outcomeUnknown:false })
        expect(operation).not.toHaveBeenCalled(); expect(f.service.runEffect).not.toHaveBeenCalled()
    })

    it('keeps concurrent reply lifecycles and task targets isolated', async () => {
        const f = fixture(); const adapter = new AsyncProjectInvocationAdapter(f.service)
        const first = deferred(); const second = deferred(); const other = { ...target,messageId:'message-2',queueId:'queue-2' }
        const a = run(adapter,async () => {},async () => { await first.promise })
        const b = run(adapter,async () => {},async () => { await second.promise },other)
        await vi.waitFor(() => expect(f.active.size).toBe(2))
        second.resolve(); await b
        expect(f.active).toEqual(new Set(['queue-1']))
        first.resolve(); await a
        expect(f.active.size).toBe(0); expect(f.service.acceptResult).toHaveBeenCalledTimes(2)
    })

    it('freezes the initial target and never routes a later caller mutation', async () => {
        const f = fixture(); const incoming = { ...target }; const adapter = new AsyncProjectInvocationAdapter(f.service)
        const running = adapter.run(incoming,async () => { await runProjectInvocationEffect(target,async () => {}) },true)
        incoming.queueId='different'; incoming.messageId='different'
        await running
        expect(f.service.resolve).toHaveBeenCalledWith(target)
        expect(f.service.runEffect).toHaveBeenCalledWith(expect.anything(),target,expect.any(Function))
    })
})

describe('truthful async failure and cancellation', () => {
    it('rejects cancellation before dispatch without starting a service or executor', async () => {
        const f=fixture(); const controller=new AbortController(); controller.abort(); const effect=vi.fn(async () => {})
        await expect(run(new AsyncProjectInvocationAdapter(f.service),effect,undefined,target,controller.signal)).rejects.toMatchObject({ code:'PROJECT_INVOCATION_ABORTED',outcomeUnknown:false })
        expect(f.service.resolve).not.toHaveBeenCalled(); expect(effect).not.toHaveBeenCalled()
    })

    it('holds cancellation after preparation but before the last launch hook', async () => {
        const f=fixture(); const controller=new AbortController(); const prepare=deferred(); const effect=vi.fn(async () => {})
        const running=new AsyncProjectInvocationAdapter(f.service).run(target,async () => { await prepare.promise; await runProjectInvocationEffect(target,effect) },true,controller.signal)
        await vi.waitFor(() => expect(f.service.resolve).toHaveBeenCalledOnce())
        controller.abort(); prepare.resolve()
        await expect(running).rejects.toMatchObject({ outcomeUnknown:false }); expect(effect).not.toHaveBeenCalled()
    })

    it('rechecks cancellation after async service acquisition, at the actual callback', async () => {
        const permit=deferred(); const controller=new AbortController(); const effect=vi.fn(async () => {})
        const f=fixture({ runEffect:vi.fn(async (_b,_t,invoke) => { await permit.promise; await invoke() }) })
        const running=run(new AsyncProjectInvocationAdapter(f.service),effect,undefined,target,controller.signal)
        await vi.waitFor(() => expect(f.service.runEffect).toHaveBeenCalledOnce())
        controller.abort(); permit.resolve()
        await expect(running).rejects.toMatchObject({ outcomeUnknown:false })
        expect(effect).not.toHaveBeenCalled(); expect(f.service.acceptResult).not.toHaveBeenCalled()
    })

    it('does not detach a cancelled active run or verify it as successful', async () => {
        const f=fixture(); const controller=new AbortController(); const tail=deferred(); const effect=vi.fn(async () => {})
        let settled=false
        const running=run(new AsyncProjectInvocationAdapter(f.service),effect,async () => { await tail.promise },target,controller.signal).catch(cause => { settled=true; return cause })
        await vi.waitFor(() => expect(f.active.size).toBe(1)); controller.abort()
        await Promise.resolve(); expect(settled).toBe(false); expect(f.active.size).toBe(1)
        tail.resolve(); expect(await running).toMatchObject({ outcomeUnknown:true })
        expect(f.active.size).toBe(0); expect(effect).toHaveBeenCalledOnce(); expect(f.service.acceptResult).not.toHaveBeenCalled()
    })

    it('retains unknown outcome after reply/stream failure and awaits the fence exit', async () => {
        const f=fixture(); const effect=vi.fn(async () => {})
        await expect(run(new AsyncProjectInvocationAdapter(f.service),effect,async () => { throw new Error('STREAM_ACK_LOST') })).rejects.toMatchObject({ outcomeUnknown:true })
        expect(effect).toHaveBeenCalledOnce(); expect(f.active.size).toBe(0); expect(f.service.acceptResult).not.toHaveBeenCalled()
    })

    it('rejects lost fence-exit acknowledgement before result verification', async () => {
        const f=fixture({ runEffect:async (_b,_t,invoke) => { await invoke(); throw new Error('FENCE_EXIT_ACK_LOST') } })
        await expect(run(new AsyncProjectInvocationAdapter(f.service),async () => {})).rejects.toMatchObject({ outcomeUnknown:true })
        expect(f.service.acceptResult).not.toHaveBeenCalled()
    })

    it('keeps independent result rejection separate from execution completion', async () => {
        const f=fixture({ acceptResult:async () => { throw new Error('RESULT_WRONG_REQUEST') } })
        await expect(run(new AsyncProjectInvocationAdapter(f.service),async () => {})).rejects.toMatchObject({ code:'RESULT_NOT_ACCEPTED',outcomeUnknown:true })
        expect(f.active.size).toBe(0)
    })
})

describe('faulty-service protocol boundaries', () => {
    it('rejects a missing callback and closes a delayed callback', async () => {
        let delayed!: () => Promise<void>
        const f=fixture({ runEffect:async (_b,_t,invoke) => { delayed=invoke } }); const effect=vi.fn(async () => {})
        await expect(run(new AsyncProjectInvocationAdapter(f.service),effect)).rejects.toMatchObject({ outcomeUnknown:false })
        expect(() => delayed()).toThrow('INVOCATION_CALLBACK_CLOSED'); expect(effect).not.toHaveBeenCalled()
    })

    it('rejects a repeated callback even when the service catches the rejection', async () => {
        const f=fixture({ runEffect:async (_b,_t,invoke) => { const first=invoke(); try { await invoke() } catch {} await first } })
        const effect=vi.fn(async () => {})
        await expect(run(new AsyncProjectInvocationAdapter(f.service),effect)).rejects.toMatchObject({ outcomeUnknown:true })
        expect(effect).toHaveBeenCalledOnce(); expect(f.service.acceptResult).not.toHaveBeenCalled()
    })

    it('awaits a started launch even if the service returns without awaiting its callback', async () => {
        const native=deferred(); let started=false; let settled=false
        const f=fixture({ runEffect:async (_b,_t,invoke) => { void invoke() } })
        const running=run(new AsyncProjectInvocationAdapter(f.service),async () => { started=true; await native.promise }).catch(cause => { settled=true; return cause })
        await vi.waitFor(() => expect(started).toBe(true)); expect(settled).toBe(false)
        native.resolve(); expect(await running).toMatchObject({ outcomeUnknown:true })
        expect(f.service.acceptResult).not.toHaveBeenCalled()
    })

    it('rejects lifecycle completion after a known early fence exit, even if the reply later finishes', async () => {
        const releaseFence=deferred(); const tail=deferred(); const streamed=deferred()
        let callbackOutcome='pending'
        const f=fixture({ runEffect:async (_b,_t,invoke) => {
            void invoke().then(() => { callbackOutcome='success' },() => { callbackOutcome='failure' })
            await releaseFence.promise
        } })
        const running=run(new AsyncProjectInvocationAdapter(f.service),async () => {},async () => { streamed.resolve(); await tail.promise })
        await streamed.promise; releaseFence.resolve()
        await vi.waitFor(() => expect(f.service.runEffect).toBeTypeOf('function'))
        // Let the backend's acknowledged early exit be observed while the stream remains active.
        await new Promise(resolve => setTimeout(resolve,0))
        tail.resolve()
        await expect(running).rejects.toMatchObject({ outcomeUnknown:true })
        expect(callbackOutcome).toBe('failure'); expect(f.service.acceptResult).not.toHaveBeenCalled()
    })

    it('never promotes a swallowed callback error to successful delivery', async () => {
        const f=fixture({ runEffect:async (_b,_t,invoke) => { try { await invoke() } catch {} } })
        const effect=vi.fn(async () => { throw new Error('NATIVE_ACK_LOST') })
        await expect(run(new AsyncProjectInvocationAdapter(f.service),effect)).rejects.toMatchObject({ outcomeUnknown:true })
        expect(effect).toHaveBeenCalledOnce(); expect(f.service.acceptResult).not.toHaveBeenCalled()
    })
})

function queueFixture(service: ProjectInvocationHost, tail: () => Promise<void> = async () => {}) {
    const clients=createProtectedProjectAgentClients(service) as any
    const effect=vi.fn(async () => ({ run_id:'fixture-run' }))
    const agent={ agentId:target.agentId,name:'Worker',connected:true,projectInvocationBoundary:true as const,
        replyToMention:async () => { await runProjectInvocationEffect(target,effect); await tail() },releaseInvocation:vi.fn() }
    clients.rooms.set(target.roomId,new Map([[agent.agentId,agent]]))
    const storage={enqueueExecutionQueueItem:vi.fn(() => ({id:target.queueId})),startExecutionQueueItem:vi.fn(() => true),finishExecutionQueueItem:vi.fn()}
    clients._storage=storage
    const message={messageId:target.messageId,content:'@Worker work',senderName:'Owner',senderId:'member-1',timestamp:1,role:'user' as const}
    return {clients,effect,agent,storage,message}
}

describe('explicit factory through the actual Group Chat queue', () => {
    it('does not complete or verify a queued task while the async reply is still running', async () => {
        const f=fixture(); const tail=deferred()
        const q=queueFixture(f.service,async () => { expect(f.active.has(target.queueId)).toBe(true); await tail.promise })
        const running=q.clients.processMentions(target.roomId,q.message)
        await vi.waitFor(() => expect(q.effect).toHaveBeenCalledOnce())
        expect(q.storage.finishExecutionQueueItem).not.toHaveBeenCalled(); expect(f.service.acceptResult).not.toHaveBeenCalled()
        tail.resolve(); expect(await running).toMatchObject({deliveredCount:1})
        expect(q.storage.finishExecutionQueueItem).toHaveBeenCalledWith(target.queueId,'completed')
        expect(f.events.at(-1)).toBe('verify:queue-1'); expect(q.agent.releaseInvocation).toHaveBeenCalledOnce()
    })

    it('marks async reply failure unknown instead of delivered and never retries', async () => {
        const f=fixture(); const q=queueFixture(f.service,async () => { throw new Error('STREAM_FAILED') })
        expect(await q.clients.processMentions(target.roomId,q.message)).toMatchObject({deliveredCount:0,outcomeUnknown:true})
        expect(q.effect).toHaveBeenCalledOnce(); expect(q.storage.finishExecutionQueueItem).toHaveBeenCalledWith(target.queueId,'failed',expect.any(String))
        expect(f.service.acceptResult).not.toHaveBeenCalled()
    })

    it('keeps result rejection unknown after execution without publishing queue success', async () => {
        const f=fixture({acceptResult:async () => { throw new Error('UNVERIFIED_RESULT') }}); const q=queueFixture(f.service)
        expect(await q.clients.processMentions(target.roomId,q.message)).toMatchObject({deliveredCount:0,outcomeUnknown:true})
        expect(q.effect).toHaveBeenCalledOnce(); expect(q.storage.finishExecutionQueueItem).toHaveBeenCalledWith(target.queueId,'failed','RESULT_NOT_ACCEPTED')
    })
})
