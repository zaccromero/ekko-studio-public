import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'
import { CanonicalProjectInvocationHost, type CanonicalInvocationHooks } from '../../packages/server/src/modules/studio/services/group-chat/canonical-project-invocation'
import { createCanonicalProjectAgentClients } from '../../packages/server/src/bootstrap/canonical-project-invocation'
import { AsyncProjectInvocationAdapter } from '../../packages/server/src/modules/studio/services/group-chat/async-project-invocation'
import { runProjectInvocationEffect, type BoundProjectInvocation } from '../../packages/server/src/modules/studio/services/group-chat/project-invocation'

const target = { roomId: 'bridge', messageId: 'm1', agentId: 'codex-1', queueId: 'q1' }
const canonical = process.env.CANONICAL_PROJECT_SOURCE
const python = process.env.CANONICAL_TEST_PYTHON || 'python3'
function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(yes => { resolve = yes })
    return { promise, resolve }
}
const owned: { child: ChildProcessWithoutNullStreams; service: CanonicalProjectInvocationHost; root: string }[] = []
const releases: (() => void)[] = []
afterEach(async () => {
    for (const release of releases.splice(0)) release()
    for (const item of owned.splice(0)) {
        try { await Promise.race([item.service.close(), new Promise((_, no) => setTimeout(() => no(new Error('fixture close')), 1500))]) }
        catch { /* Only these synthetic, test-owned processes are stopped. */ }
        if (item.child.exitCode === null) {
            const exited = new Promise<void>(yes => item.child.once('exit', () => yes()))
            item.child.kill('SIGTERM'); await exited
        }
        await rm(item.root, { recursive: true, force: true })
    }
})

async function fixture(overrides: Partial<CanonicalInvocationHooks> = {}, existing?: string) {
    const root = existing || await mkdtemp(join(tmpdir(), 'canonical-channel-'))
    const source = resolve('packages/server/src/modules/studio/services/group-chat/canonical_project_invocation.py')
    const child = spawn(python, ['-B', resolve('tests/fixtures/canonical-project-invocation-host.py'), source, root], {
        env: { ...process.env, CANONICAL_PROJECT_SOURCE: canonical!, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe',
    })
    let stderr = ''
    child.stderr.on('data', bytes => { stderr += String(bytes).slice(0, 2000) })
    // Real canonical parser, not a fork or a shape-only protocol substitute.
    const parser = await import(/* @vite-ignore */ pathToFileURL(join(canonical!, 'bin/project-carrier.mjs')).href)
    const events: string[] = []
    const hooks: CanonicalInvocationHooks = {
        parseCarrier: parser.parseCarrier,
        effect: async (_binding, _target, approved, invoke) => {
            expect(Buffer.from(approved).toString()).toBe('approved fixture input')
            expect(JSON.parse(await readFile(join(root, 'fence.json'), 'utf8')).inside).toBe(true)
            events.push('effect'); await invoke(); events.push('reply-finished')
            return Buffer.from('saved fixture result')
        },
        verifyResult: vi.fn(async (_binding, _target, result) => {
            expect(JSON.parse(await readFile(join(root, 'fence.json'), 'utf8')).inside).toBe(false)
            expect(Buffer.from(result).toString()).toBe('saved fixture result')
            events.push('verified')
        }),
        ...overrides,
    }
    const { clients, service } = createCanonicalProjectAgentClients({ readable: child.stdout, writable: child.stdin }, hooks)
    owned.push({ child, service, root })
    let binding: BoundProjectInvocation
    try { binding = await service.resolve(target) }
    catch (cause) { throw new Error('canonical fixture failed: ' + stderr, { cause }) }
    return { root, child, service, clients, hooks, events, binding,
        control: (value: object) => writeFile(join(root, 'control.json'), JSON.stringify(value)) }
}

function run(service: CanonicalProjectInvocationHost, operation: () => Promise<unknown> = async () => {}, tail: () => Promise<void> = async () => {}) {
    return new AsyncProjectInvocationAdapter(service).run(target, async () => {
        await runProjectInvocationEffect(target, operation); await tail()
    }, true)
}

// The private canonical repository is an explicit host/test dependency. CI without
// it exercises protocol negatives below, and reports these cases SKIPPED. The
// required local connection gate always supplies it and must run all real cases.
describe.skipIf(!canonical)('real canonical Python / TypeScript connection', () => {
    it('holds the actual canonical fence across full reply and verifies after commit', async () => {
        const f = await fixture(), tail = deferred(), streamed = deferred()
        releases.push(tail.resolve)
        const pending = run(f.service, async () => { f.events.push('launch') }, async () => { streamed.resolve(); await tail.promise })
        await streamed.promise
        expect(JSON.parse(await readFile(join(f.root, 'fence.json'), 'utf8')).inside).toBe(true)
        expect(f.hooks.verifyResult).not.toHaveBeenCalled()
        tail.resolve(); await pending
        expect(f.events).toEqual(['effect', 'launch', 'reply-finished', 'verified'])
    })

    it('rejects fresh credential or human-provenance denial before dispatch', async () => {
        const f = await fixture(), operation = vi.fn(async () => {})
        await f.control({ denyEffect: true })
        await expect(run(f.service, operation)).rejects.toMatchObject({ outcomeUnknown: false })
        expect(operation).not.toHaveBeenCalled()
        await f.control({ noHuman: true })
        await expect(run(f.service, operation)).rejects.toBeInstanceOf(Error)
        expect(operation).not.toHaveBeenCalled()
    })

    it('cannot change a stored target, association or carrier from the client', async () => {
        const f = await fixture(), operation = vi.fn(async () => {})
        await expect(f.service.resolve({ ...target, queueId: 'other' })).rejects.toBeInstanceOf(Error)
        await expect(f.service.runEffect({ ...f.binding, association: { ...f.binding.association, project: 'milo' } }, target, operation)).rejects.toBeInstanceOf(Error)
        await expect(f.service.runEffect({ ...f.binding, carrier: { ...f.binding.carrier, binding_digest: 'f'.repeat(64) } }, target, operation)).rejects.toBeInstanceOf(Error)
        expect(operation).not.toHaveBeenCalled()
    })

    it('records a failed callback as unknown and never retries it', async () => {
        const f = await fixture(), operation = vi.fn(async () => { throw new Error('synthetic failure') })
        await expect(run(f.service, operation)).rejects.toMatchObject({ outcomeUnknown: true })
        await expect(run(f.service, operation)).rejects.toMatchObject({ outcomeUnknown: true })
        expect(operation).toHaveBeenCalledOnce()
        await expect(f.service.recoverResult(f.binding, target)).rejects.toBeInstanceOf(Error)
        expect(f.hooks.verifyResult).not.toHaveBeenCalled()
    })

    it('never accepts a lost canonical fence-exit acknowledgment', async () => {
        const f = await fixture(), operation = vi.fn(async () => {})
        await f.control({ exitFail: true })
        await expect(run(f.service, operation)).rejects.toMatchObject({ outcomeUnknown: true })
        expect(operation).toHaveBeenCalledOnce(); expect(f.hooks.verifyResult).not.toHaveBeenCalled()
    })

    it('requires fresh authority for saved-result recovery', async () => {
        const f = await fixture(); await run(f.service)
        await f.control({ denyResume: true })
        await expect(f.service.recoverResult(f.binding, target)).rejects.toBeInstanceOf(Error)
        expect(f.hooks.verifyResult).toHaveBeenCalledOnce()
    })

    it('recovers the durable same-request result without executing again', async () => {
        const f = await fixture(), operation = vi.fn(async () => {})
        await run(f.service, operation)
        expect(Buffer.from(await f.service.recoverResult(f.binding, target)).toString()).toBe('saved fixture result')
        await expect(run(f.service, operation)).rejects.toBeInstanceOf(Error)
        expect(operation).toHaveBeenCalledOnce()
    })

    it('rejects independent result-verification failure before queue delivery', async () => {
        const f = await fixture({ verifyResult: async () => { throw new Error('unverified fixture result') } })
        const effect = vi.fn(async () => ({}))
        const agent = { agentId: target.agentId, name: 'Worker', connected: true, projectInvocationBoundary: true,
            replyToMention: async () => { await runProjectInvocationEffect(target, effect) }, releaseInvocation: vi.fn() }
        const clients = f.clients as any
        clients.rooms.set(target.roomId, new Map([[target.agentId, agent]]))
        const finish = vi.fn()
        clients._storage = { enqueueExecutionQueueItem: () => ({ id: target.queueId }), startExecutionQueueItem: () => true, finishExecutionQueueItem: finish }
        const result = await clients.processMentions(target.roomId, { messageId: target.messageId, content: '@Worker work', senderName: 'Owner', senderId: 'member-1', timestamp: 1, role: 'user' })
        expect(result).toMatchObject({ deliveredCount: 0, outcomeUnknown: true })
        expect(effect).toHaveBeenCalledOnce(); expect(finish).toHaveBeenCalledWith(target.queueId, 'failed', 'RESULT_NOT_ACCEPTED')
    })

    it('drains a prematurely returning protected hook before releasing the fence', async () => {
        const tail = deferred(), streamed = deferred(); releases.push(tail.resolve)
        const f = await fixture({ effect: async (_b, _t, _p, invoke) => { void invoke(); return Buffer.from('saved fixture result') } })
        const pending = run(f.service, async () => {}, async () => { streamed.resolve(); await tail.promise })
        await streamed.promise
        expect(JSON.parse(await readFile(join(f.root, 'fence.json'), 'utf8')).inside).toBe(true)
        tail.resolve(); await pending
    })

    it('drains a hook failure after launch, then reports unknown', async () => {
        const tail = deferred(), streamed = deferred(); releases.push(tail.resolve)
        const f = await fixture({ effect: async (_b, _t, _p, invoke) => { void invoke(); throw new Error('hook failed') } })
        const pending = run(f.service, async () => {}, async () => { streamed.resolve(); await tail.promise })
        void pending.catch(() => {})
        await streamed.promise
        expect(JSON.parse(await readFile(join(f.root, 'fence.json'), 'utf8')).inside).toBe(true)
        tail.resolve(); await expect(pending).rejects.toMatchObject({ outcomeUnknown: true })
    })

    it('requires its protected hook to invoke exactly once', async () => {
        const f = await fixture({ effect: async (_b, _t, _p, invoke) => {
            await invoke(); try { await invoke() } catch { /* must remain a sticky failure */ }
            return Buffer.from('saved fixture result')
        } })
        const operation = vi.fn(async () => {})
        await expect(run(f.service, operation)).rejects.toMatchObject({ outcomeUnknown: true })
        expect(operation).toHaveBeenCalledOnce(); expect(f.hooks.verifyResult).not.toHaveBeenCalled()
    })

    it('rejects a missing actual effect callback', async () => {
        const f = await fixture({ effect: async () => Buffer.from('saved fixture result') }), operation = vi.fn(async () => {})
        await expect(run(f.service, operation)).rejects.toMatchObject({ outcomeUnknown: false })
        expect(operation).not.toHaveBeenCalled()
        // Local callback never started, but the canonical STARTED receipt remains unknown.
        await expect(f.service.resolve(target)).rejects.toMatchObject({ outcomeUnknown: true })
    })

    it('graceful close keeps reading settlement while draining an active reply', async () => {
        const tail = deferred(), streamed = deferred(); releases.push(tail.resolve)
        const f = await fixture()
        const pending = run(f.service, async () => {}, async () => { streamed.resolve(); await tail.promise })
        await streamed.promise
        // Invoke directly here: close rejects the adapter's later recovery request.
        const closing = f.service.close()
        await new Promise(yes => setImmediate(yes))
        expect(JSON.parse(await readFile(join(f.root, 'fence.json'), 'utf8')).inside).toBe(true)
        tail.resolve()
        await expect(pending).rejects.toBeInstanceOf(Error)
        await closing
        expect(JSON.parse(await readFile(join(f.root, 'fence.json'), 'utf8')).inside).toBe(false)
    })

    it('rejects incomplete targets before sending a request', async () => {
        const f = await fixture()
        await expect(f.service.resolve({ ...target, messageId: null })).rejects.toMatchObject({ outcomeUnknown: false })
    })

    it('does not treat pipe loss as successful delivery or an automatic retry', async () => {
        const tail = deferred(), streamed = deferred(); releases.push(tail.resolve)
        const f = await fixture(), operation = vi.fn(async () => {})
        const pending = run(f.service, operation, async () => { streamed.resolve(); await tail.promise })
        void pending.catch(() => {})
        await streamed.promise
        f.child.stdout.destroy(); f.child.stdin.destroy()
        await new Promise(yes => setImmediate(yes))
        expect(JSON.parse(await readFile(join(f.root, 'fence.json'), 'utf8')).inside).toBe(true)
        tail.resolve(); await expect(pending).rejects.toMatchObject({ outcomeUnknown: true })
        expect(operation).toHaveBeenCalledOnce(); expect(f.hooks.verifyResult).not.toHaveBeenCalled()
    })
})

function protocolFixture() {
    const readable = new PassThrough(), writable = new PassThrough()
    const service = new CanonicalProjectInvocationHost({ readable, writable }, {
        parseCarrier: value => value as any,
        effect: async (_b, _t, _p, invoke) => { await invoke(); return new Uint8Array() }, verifyResult: async () => {},
    })
    return { readable, writable, service }
}

describe('private channel protocol fails closed without an authority substitute', () => {
    it('requires fixed protected hooks instead of defaults', () => {
        expect(() => new CanonicalProjectInvocationHost({ readable: new PassThrough(), writable: new PassThrough() }, {} as any)).toThrow('NOT_ENABLED')
    })
    it('rejects an invalid channel version before dispatch', async () => {
        const f = protocolFixture(); f.readable.write('{"v":2,"type":"ready"}\n')
        await expect(f.service.resolve(target)).rejects.toMatchObject({ outcomeUnknown: true })
    })
    it('rejects oversized frames without dispatch', async () => {
        const f = protocolFixture(); f.readable.write(Buffer.alloc(2 * 1024 * 1024 + 1, 120))
        await expect(f.service.resolve(target)).rejects.toMatchObject({ outcomeUnknown: true })
    })
    it('rejects EOF while waiting for the backend, without retry', async () => {
        const f = protocolFixture(); f.readable.end()
        await expect(f.service.resolve(target)).rejects.toMatchObject({ outcomeUnknown: true })
    })
})
