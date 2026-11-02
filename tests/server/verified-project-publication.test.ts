import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { AsyncResource } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createVerifiedProjectAgentClients } from '../../packages/server/src/bootstrap/verified-project-publication'
import { VerifiedProjectPublication, type PublicationHooks, type ProjectPublisher } from '../../packages/server/src/modules/studio/services/group-chat/verified-project-publication'
import { runProjectInvocationEffect, type ProjectInvocationTarget } from '../../packages/server/src/modules/studio/services/group-chat/project-invocation'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const target = { roomId: 'bridge', messageId: 'm1', agentId: 'codex-1', queueId: 'q1' }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { resolve, promise } }
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks() })

// Protocol-only backend: real canonical authority/journal proof is separate below.
function protocol(options: { corruptRecovery?: boolean } = {}) {
    const readable = new PassThrough(), writable = new PassThrough(), payload = Buffer.from('approved input')
    const requests = new Map<string, any>(), results = new Map<string, string>()
    const identity = (t: any) => JSON.stringify(t)
    // Model a child-process readable callback created outside adapter.run().
    const outside = new AsyncResource('canonical-transport-outside-publication')
    cleanups.push(async () => { outside.emitDestroy() })
    const send = (value: unknown) => outside.runInAsyncScope(() => readable.write(JSON.stringify(value) + '\n'))
    const response = (id: string, value: unknown) => send({ v: 1, type: 'response', id, ok: true, value })
    let input = ''
    writable.on('data', bytes => {
        input += String(bytes)
        while (input.includes('\n')) {
            const end = input.indexOf('\n'), packet = JSON.parse(input.slice(0, end)); input = input.slice(end + 1)
            if (packet.type === 'close') { send({ v: 1, type: 'closed' }); continue }
            if (packet.type === 'settled') {
                const request = requests.get(packet.id)
                if (!packet.ok) { send({ v: 1, type: 'response', id: packet.id, ok: false, unknown: true, code: 'fixture_failed' }); continue }
                results.set(identity(request.target), packet.result)
                response(packet.id, { status: 'COMPLETED', result_digest: hash(Buffer.from(packet.result, 'base64')) })
                continue
            }
            requests.set(packet.id, packet)
            if (packet.method === 'resolve') response(packet.id, {
                carrier: { version: 1, binding_ref: 'r-' + packet.target.queueId, binding_digest: 'a'.repeat(64) },
                association: { project: 'gym-nyc', request_id: 'r-' + packet.target.queueId, execution_id: 'x-' + packet.target.queueId, payload_digest: hash(payload) },
            })
            else if (packet.method === 'invoke') send({ v: 1, type: 'effect', id: packet.id, target: packet.target, carrier: packet.carrier, association: packet.association, payload: payload.toString('base64') })
            else if (packet.method === 'recover') {
                const result = options.corruptRecovery ? Buffer.from('wrong output').toString('base64') : results.get(identity(packet.target))!
                response(packet.id, { status: 'COMPLETED', result, result_digest: hash(Buffer.from(result, 'base64')) })
            }
        }
    })
    queueMicrotask(() => send({ v: 1, type: 'ready' }))
    return { transport: { readable, writable }, results }
}
function hooks(overrides: Partial<PublicationHooks> = {}): PublicationHooks {
    return { parseCarrier: value => value as any, effect: async (_b, _t, _p, invoke) => { await invoke() }, verifyResult: async () => {}, ...overrides }
}
function publisher(operation: ProjectPublisher['publish'] = async (_binding, context, manifest) => ({ status: 'PUBLISHED', publicationId: 'publication-1', manifestDigest: hash(manifest), target: context })) {
    return { publish: vi.fn(operation) }
}
function config(agentId = 'codex-1', name = 'Worker') { return { agentId, name, profile: 'default', description: 'synthetic fixture', agent: 'codex' as const } }
function setup(options: { hooks?: Partial<PublicationHooks>; publisher?: ProjectPublisher; corruptRecovery?: boolean } = {}) {
    const back = protocol(options), output = options.publisher || publisher()
    const app = createVerifiedProjectAgentClients(back.transport, hooks(options.hooks), output)
    const agent = app.registerAgent('bridge', config())
    const finish = vi.fn()
    app.setStorage({ enqueueExecutionQueueItem: () => ({ id: 'q1' }), startExecutionQueueItem: () => true, finishExecutionQueueItem: finish })
    cleanups.push(() => app.close())
    const reply = vi.spyOn(agent, 'replyToMention').mockImplementation(async (roomId, msg) => {
        await runProjectInvocationEffect({ roomId, messageId: msg.messageId || null, agentId: agent.agentId }, async () => {})
        agent.emitMessageStreamStart(roomId, 'out-1')
        agent.emitMessageStreamDelta(roomId, 'out-1', 'private answer')
        await agent.sendMessage(roomId, 'private answer', 'out-1', { role: 'assistant' })
        agent.emitMessageStreamEnd(roomId, 'out-1')
    })
    const run = () => app.processMentions('bridge', { messageId: 'm1', content: '@Worker work', senderId: 'owner', senderName: 'Owner', timestamp: 1, role: 'user' })
    return { app, agent, finish, reply, run, output, back }
}

describe('verified private publication', () => {
    it('holds actual AgentClient output until saved-result verification and waits for publisher ACK before queue success', async () => {
        const verifying = deferred(), verified = deferred(), publishing = deferred(), published = deferred()
        const output = publisher(async (_b, context, manifest) => {
            publishing.resolve(); await published.promise
            return { status: 'PUBLISHED', publicationId: 'p1', target: context, manifestDigest: hash(manifest) }
        })
        const f = setup({ hooks: { verifyResult: async (_b, _t, saved) => {
            const manifest = JSON.parse(Buffer.from(saved).toString()); expect(manifest.events).toHaveLength(4)
            expect(output.publish).not.toHaveBeenCalled(); verifying.resolve(); await verified.promise
        } }, publisher: output })
        cleanups.unshift(async () => { verified.resolve(); published.resolve() })
        const pending = f.run(); await verifying.promise
        expect(f.finish).not.toHaveBeenCalled(); expect(output.publish).not.toHaveBeenCalled()
        verified.resolve(); await publishing.promise
        expect(f.finish).not.toHaveBeenCalled()
        published.resolve(); expect(await pending).toMatchObject({ deliveredCount: 1 })
        expect(f.finish).toHaveBeenCalledWith('q1', 'completed'); expect(output.publish).toHaveBeenCalledOnce()
        const manifest = output.publish.mock.calls[0][2]
        expect(JSON.parse(manifest)).toMatchObject({ version: 1, target, events: [{ kind: 'event' }, { kind: 'event' }, { kind: 'message', content: 'private answer' }, { kind: 'event' }] })
        expect(Buffer.from(f.back.results.get(JSON.stringify(target))!, 'base64').toString()).toBe(manifest)
    })
    it.each(['denied', 'wrong saved bytes'] as const)('publishes nothing after %s', async reason => {
        const f = setup(reason === 'denied' ? { hooks: { verifyResult: async () => { throw new Error('denied') } } } : { corruptRecovery: true })
        expect(await f.run()).toMatchObject({ deliveredCount: 0, outcomeUnknown: true })
        expect(f.output.publish).not.toHaveBeenCalled(); expect(f.finish).toHaveBeenCalledWith('q1', 'failed', 'RESULT_NOT_ACCEPTED')
    })
    it.each(['overflow', 'interactive', 'wrong room', 'accessor'] as const)('keeps swallowed %s capture failures sticky', async failure => {
        const f = setup()
        f.reply.mockImplementation(async (roomId, msg) => {
            await runProjectInvocationEffect({ roomId, messageId: msg.messageId || null, agentId: 'codex-1' }, async () => {})
            try {
                if (failure === 'overflow') await f.agent.sendMessage(roomId, 'x'.repeat(1024 * 1024 + 1), 'm')
                else if (failure === 'interactive') f.agent.emitApprovalRequested(roomId, { message: 'approval' })
                else if (failure === 'wrong room') await f.agent.sendMessage('wrong', 'private', 'm')
                else await f.agent.sendMessage(roomId, 'private', 'm', { role: 'tool', nested: Object.defineProperty({}, 'bad', { enumerable: true, get() { throw new Error('getter executed') } }) })
            } catch { /* The outer protected invocation must still fail. */ }
        })
        expect(await f.run()).toMatchObject({ deliveredCount: 0, outcomeUnknown: true })
        expect(f.output.publish).not.toHaveBeenCalled()
    })
    it('copies queued content before a caller can mutate it', async () => {
        const f = setup()
        f.reply.mockImplementation(async (roomId, msg) => {
            await runProjectInvocationEffect({ roomId, messageId: msg.messageId || null, agentId: 'codex-1' }, async () => {})
            const extra = { role: 'tool', nested: { output: 'approved original' } }
            await f.agent.sendMessage(roomId, 'answer', 'out', extra); extra.nested.output = 'changed'
        })
        expect(await f.run()).toMatchObject({ deliveredCount: 1 })
        const mock = f.output.publish as ReturnType<typeof vi.fn>
        expect(JSON.parse(mock.mock.calls[0][2]).events[0].extra.nested.output).toBe('approved original')
    })
    it.each(['wrong digest', 'lost ACK'] as const)('reports %s as UNKNOWN and never retries publication or execution', async failure => {
        const output = publisher(async (_b, context) => {
            if (failure === 'lost ACK') throw new Error('possibly published')
            return { status: 'PUBLISHED', publicationId: 'p', target: context, manifestDigest: 'f'.repeat(64) }
        })
        const f = setup({ publisher: output })
        expect(await f.run()).toMatchObject({ deliveredCount: 0, outcomeUnknown: true })
        expect(await f.run()).toMatchObject({ deliveredCount: 0 })
        expect(output.publish).toHaveBeenCalledOnce(); expect(f.reply).toHaveBeenCalledOnce()
    })
    it('keeps concurrent full targets isolated within one composition', async () => {
        const back = protocol(), output = publisher(), adapter = new VerifiedProjectPublication(back.transport, hooks(), output)
        cleanups.push(() => adapter.close())
        const agent = adapter.createCapturedAgent(config()), first = deferred(), release = deferred()
        cleanups.unshift(async () => { release.resolve() })
        const t2 = { ...target, messageId: 'm2', queueId: 'q2' }
        const run = (t: ProjectInvocationTarget, text: string, hold = false) => adapter.run(t, async () => {
            await runProjectInvocationEffect(t, async () => {})
            await agent.sendMessage(t.roomId, text, text)
            if (hold) { first.resolve(); await release.promise }
        }, true)
        const a = run(target, 'first', true); await first.promise
        await run(t2, 'second'); expect(output.publish).toHaveBeenCalledOnce()
        release.resolve(); await a
        expect(output.publish.mock.calls.map(c => JSON.parse(c[2]).events[0].content)).toEqual(['second', 'first'])
    })
    it('rejects unbound output, arbitrary executor/socket paths and unqualified continuations', async () => {
        const f = setup()
        await expect(f.agent.sendMessage('bridge', 'outside', 'out')).rejects.toThrow('PUBLICATION_SCOPE_REQUIRED')
        expect((f.app as any).createAgent).toBeUndefined(); expect((f.app as any).registerAgentForRoom).toBeUndefined()
        expect(() => f.app.processMentions('bridge', { continuationAttemptId: 'attempt' } as any)).toThrow('QUALIFIED_CONTINUATION_PUBLICATION_REQUIRED')
        expect(() => f.app.registerAgent('bridge', config())).toThrow('CAPTURED_AGENT_REGISTRATION_REQUIRED')
        expect(f.output.publish).not.toHaveBeenCalled()
    })
    it('requires fixed host hooks and a separate publisher', () => {
        const back = protocol()
        expect(() => createVerifiedProjectAgentClients(back.transport, hooks(), {} as any)).toThrow('VERIFIED_PUBLICATION_NOT_ENABLED')
    })
    it('captures output created inside an externally dispatched executor callback', async () => {
        const f = setup()
        f.reply.mockImplementation(async (roomId, msg) => {
            await runProjectInvocationEffect({ roomId, messageId: msg.messageId || null, agentId: 'codex-1' }, async () => {
                await new Promise(yes => setImmediate(yes))
                f.agent.emitMessageStreamDelta(roomId, 'out', 'external async answer')
                await f.agent.sendMessage(roomId, 'external async answer', 'out')
            })
        })
        expect(await f.run()).toMatchObject({ deliveredCount: 1 })
        const output = f.output.publish as ReturnType<typeof vi.fn>
        expect(JSON.parse(output.mock.calls[0][2]).events[1].content).toBe('external async answer')
    })
    it.each([false, true])('stages actual workspace finalization before verification (verification denied=%s)', async deny => {
        const f = setup({ hooks: { verifyResult: async () => { if (deny) throw new Error('denied') } } })
        const workspace = await mkdtemp(join(tmpdir(), 'publication-workspace-'))
        const { writeFile } = await import('node:fs/promises')
        cleanups.push(() => rm(workspace, { recursive: true, force: true }))
        await writeFile(join(workspace, 'example.txt'), 'before\n')
        const rawWriter = vi.fn(() => { throw new Error('unverified live writer reached') })
        f.app.setStorage({
            getRoom: () => ({ id: 'bridge', workspace }),
            enqueueExecutionQueueItem: () => ({ id: 'q1' }), startExecutionQueueItem: () => true,
            finishExecutionQueueItem: f.finish, saveWorkspaceDiffMessageForRun: rawWriter,
        })
        f.reply.mockImplementation(async (roomId, msg) => {
            await runProjectInvocationEffect({ roomId, messageId: msg.messageId || null, agentId: 'codex-1' }, async () => {
                const agent = f.agent as any
                agent.activeSessions.set(roomId, 'synthetic-session')
                const state = agent.beginWorkspaceDiffIfNeeded({ roomId, sessionId: 'synthetic-session', runId: 'synthetic-run', responseRunId: 'out', workspace })
                await writeFile(join(workspace, 'example.txt'), 'after\n')
                await agent.finalizeWorkspaceDiffOnce(state, 'completed', 'out')
                expect(rawWriter).not.toHaveBeenCalled()
                expect(f.output.publish).not.toHaveBeenCalled()
            })
        })
        expect(await f.run()).toMatchObject({ deliveredCount: deny ? 0 : 1 })
        expect(rawWriter).not.toHaveBeenCalled()
        if (deny) expect(f.output.publish).not.toHaveBeenCalled()
        else {
            const output = f.output.publish as ReturnType<typeof vi.fn>, events = JSON.parse(output.mock.calls[0][2]).events
            expect(events).toHaveLength(1)
            expect(events[0]).toMatchObject({ kind: 'workspace_diff', args: { roomId: 'bridge', senderId: 'codex-1', draft: { files_changed: 1 } } })
            expect(events[0].args.draft.files[0].patch).toContain('after')
        }
    })
    it('latches an out-of-context workspace write even when the finalizer catches it', async () => {
        const f = setup(), outside = new AsyncResource('outside-workspace-finalizer'), rawWriter = vi.fn()
        cleanups.push(async () => { outside.emitDestroy() })
        f.app.setStorage({ enqueueExecutionQueueItem: () => ({ id: 'q1' }), startExecutionQueueItem: () => true,
            finishExecutionQueueItem: f.finish, saveWorkspaceDiffMessageForRun: rawWriter })
        f.reply.mockImplementation(async (roomId, msg) => {
            await runProjectInvocationEffect({ roomId, messageId: msg.messageId || null, agentId: 'codex-1' }, async () => {
                try { outside.runInAsyncScope(() => (f.agent as any).storage.saveWorkspaceDiffMessageForRun({ roomId, senderId: 'codex-1' })) }
                catch { /* The actual finalizer also catches persistence errors. */ }
            })
        })
        expect(await f.run()).toMatchObject({ deliveredCount: 0, outcomeUnknown: true })
        expect(rawWriter).not.toHaveBeenCalled(); expect(f.output.publish).not.toHaveBeenCalled()
    })
    it('close drains an active publisher tail, rejects new work and does not replay on cancellation', async () => {
        const back = protocol(), publishing = deferred(), released = deferred(), abort = new AbortController()
        const output = publisher(async (_b, context, manifest) => {
            publishing.resolve(); await released.promise
            return { status: 'PUBLISHED', publicationId: 'p1', target: context, manifestDigest: hash(manifest) }
        })
        const adapter = new VerifiedProjectPublication(back.transport, hooks(), output), agent = adapter.createCapturedAgent(config())
        cleanups.unshift(async () => { released.resolve() }); cleanups.push(() => adapter.close())
        const pending = adapter.run(target, async () => {
            await runProjectInvocationEffect(target, async () => {})
            await agent.sendMessage('bridge', 'answer', 'out')
        }, true, abort.signal)
        const rejected = expect(pending).rejects.toMatchObject({ outcomeUnknown: true, code: 'PUBLICATION_UNKNOWN_DO_NOT_RETRY' })
        await publishing.promise
        const closed = vi.fn(), closing = adapter.close().then(closed)
        await expect(adapter.run({ ...target, queueId: 'q2' }, async () => {}, true)).rejects.toThrow('PUBLICATION_IDENTITY_ALREADY_USED_OR_LIMIT')
        abort.abort(); await new Promise(yes => setImmediate(yes)); expect(closed).not.toHaveBeenCalled()
        released.resolve(); await rejected; await closing
        expect(closed).toHaveBeenCalledOnce(); expect(output.publish).toHaveBeenCalledOnce()
    })
})

const canonical = process.env.CANONICAL_PROJECT_SOURCE
describe.skipIf(!canonical)('actual canonical Python backend / captured AgentClient / queue source journey', () => {
    it('journals the exact output manifest and independently verifies after fence exit before publishing', async () => {
        const root = await mkdtemp(join(tmpdir(), 'verified-publication-'))
        const child: ChildProcessWithoutNullStreams = spawn(process.env.CANONICAL_TEST_PYTHON || 'python3', ['-B', resolve('tests/fixtures/canonical-project-invocation-host.py'), resolve('packages/server/src/modules/studio/services/group-chat/canonical_project_invocation.py'), root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' })
        const parser = await import(/* @vite-ignore */ pathToFileURL(join(canonical!, 'bin/project-carrier.mjs')).href)
        const order: string[] = []
        const output = publisher(async (_b, context, manifest) => {
            order.push('publisher'); expect(JSON.parse(await readFile(join(root, 'fence.json'), 'utf8')).inside).toBe(false)
            return { status: 'PUBLISHED', publicationId: 'canonical-p1', target: context, manifestDigest: hash(manifest) }
        })
        const app = createVerifiedProjectAgentClients({ readable: child.stdout, writable: child.stdin }, {
            parseCarrier: parser.parseCarrier,
            effect: async (_b, _t, payload, invoke) => {
                expect(Buffer.from(payload).toString()).toBe('approved fixture input')
                expect(JSON.parse(await readFile(join(root, 'fence.json'), 'utf8')).inside).toBe(true)
                await invoke(); order.push('full-reply')
            },
            verifyResult: async (_b, _t, saved) => {
                order.push('verified'); expect(output.publish).not.toHaveBeenCalled()
                expect(JSON.parse(await readFile(join(root, 'fence.json'), 'utf8')).inside).toBe(false)
                expect(JSON.parse(Buffer.from(saved).toString()).events[0].content).toBe('canonical answer')
            },
        }, output)
        cleanups.push(async () => {
            try { await app.close() } finally {
                if (child.exitCode === null) { const exit = new Promise<void>(yes => child.once('exit', () => yes())); child.stdin.end(); await exit }
                await rm(root, { recursive: true, force: true })
            }
        })
        const agent = app.registerAgent('bridge', config()), finish = vi.fn()
        app.setStorage({ enqueueExecutionQueueItem: () => ({ id: 'q1' }), startExecutionQueueItem: () => true, finishExecutionQueueItem: finish })
        vi.spyOn(agent, 'replyToMention').mockImplementation(async (roomId, msg) => {
            await runProjectInvocationEffect({ roomId, messageId: msg.messageId || null, agentId: agent.agentId }, async () => {
                await new Promise(yes => setImmediate(yes))
                await agent.sendMessage(roomId, 'canonical answer', 'reply-1')
            })
            expect(output.publish).not.toHaveBeenCalled()
        })
        expect(await app.processMentions('bridge', { messageId: 'm1', content: '@Worker work', senderId: 'owner', senderName: 'Owner', timestamp: 1, role: 'user' })).toMatchObject({ deliveredCount: 1 })
        expect(order).toEqual(['full-reply', 'verified', 'publisher']); expect(finish).toHaveBeenCalledWith('q1', 'completed')
    })
})
