import { afterEach, describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createProtectedDocumentControlClient } from '../../packages/server/src/bootstrap/protected-document-control'

const protocol = 'protected-document-control.v1'
const digest = 'a'.repeat(64)
const target = { roomId:'room', messageId:'message', agentId:'codex', queueId:'queue' }
const binding = { carrier:{version:1 as const,binding_ref:'request',binding_digest:'b'.repeat(64)},
    association:{project:'gym-nyc',request_id:'request',execution_id:'execution',payload_digest:'c'.repeat(64)} }
const capture = { status:'PRIVATE_CAPTURED',result_digest:digest,verified:false,publication:'NOT_RUN' }
const publication = { status:'PUBLISHED',result_digest:digest,publication_id:'publication',publication_scope:'local-documentation-file',replayed:false }
const owned: ReturnType<typeof createProtectedDocumentControlClient>[] = []
afterEach(async () => {
    for (const client of owned.splice(0)) await client.close()
})
function fixture(drained = async () => {}) {
    const readable = new PassThrough(), writable = new PassThrough(), packets: any[] = []
    let buffer = ''
    writable.on('data', value => {
        buffer += value.toString()
        let end: number
        while ((end=buffer.indexOf('\n'))!==-1) {
            packets.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1)
        }
    })
    const client = createProtectedDocumentControlClient({readable,writable,drained},target,binding)
    owned.push(client)
    return { client,readable,writable,packets,
        reply(index: number,result: unknown) {
            readable.write(JSON.stringify({protocol,type:'response',id:packets[index].id,result})+'\n')
        },
        reject(index: number,status='UNKNOWN') {
            readable.write(JSON.stringify({protocol,type:'response',id:packets[index].id,
                error:{status,code:status==='HELD'?'CONTROL_REJECTED':'RECONCILE_REQUIRED'}})+'\n')
        } }
}

describe('private protected document consumer', () => {
    it('connects without work and sends only fixed metadata on explicit execution', async () => {
        const f=fixture();expect(f.packets).toHaveLength(0)
        const call=f.client.executePrivately()
        expect(f.packets[0]).toEqual({protocol,type:'request',id:'document-1',method:'execute_privately',target,...binding})
        f.reply(0,capture);expect(await call).toEqual(capture);expect(f.packets).toHaveLength(1)
    })
    it('separates private execution, local-document publication and saved recovery', async () => {
        const f=fixture(),run=f.client.executePrivately();f.reply(0,capture);await run
        const publish=f.client.publishDocument(digest)
        expect(f.packets[1]).toMatchObject({method:'publish_document',result_digest:digest})
        f.reply(1,publication);expect((await publish).publication_scope).toBe('local-documentation-file')
        const recover=f.client.recover()
        expect(f.packets[2].method).toBe('recover');expect(f.packets[2]).not.toHaveProperty('result_digest')
        f.reply(2,publication);expect(await recover).toEqual(publication)
    })
    it('rejects private bytes or agent approval fields in response metadata', async () => {
        const f=fixture(),call=f.client.executePrivately()
        const rejected=expect(call).rejects.toMatchObject({outcomeUnknown:true})
        f.reply(0,{...capture,result:'PRIVATE note bytes',approved:true});await rejected
        await expect(f.client.executePrivately()).rejects.toMatchObject({outcomeUnknown:false})
        expect(f.packets).toHaveLength(1)
    })
    it('rejects wrong saved digests and publication scopes other than local documentation', async () => {
        for (const result of [{...publication,result_digest:'f'.repeat(64)},
                              {...publication,publication_scope:'shared-room'}]) {
            const f=fixture(),call=f.client.publishDocument(digest)
            const rejected=expect(call).rejects.toMatchObject({outcomeUnknown:true})
            f.reply(0,result);await rejected
        }
    })
    it('keeps a lost response uncertain and never replays an execution', async () => {
        const f=fixture(),call=f.client.executePrivately()
        const rejected=expect(call).rejects.toMatchObject({outcomeUnknown:true})
        f.readable.end();await rejected
        await expect(f.client.executePrivately()).rejects.toBeInstanceOf(Error)
        expect(f.packets).toHaveLength(1)
    })
    it('sends an explicit cancel and awaits the original admitted request', async () => {
        const f=fixture(),controller=new AbortController(),call=f.client.executePrivately(controller.signal)
        const rejected=expect(call).rejects.toMatchObject({outcomeUnknown:true})
        controller.abort();expect(f.packets[1]).toEqual({protocol,type:'cancel',id:'document-1'})
        f.reject(0);await rejected;expect(f.packets).toHaveLength(2)
    })
    it('rejects pre-aborted work before sending and bounds pending admissions', async () => {
        const f=fixture(),controller=new AbortController();controller.abort()
        await expect(f.client.executePrivately(controller.signal)).rejects.toBeInstanceOf(Error)
        expect(f.packets).toHaveLength(0)
        const calls=Array.from({length:8},()=>f.client.recover())
        const rejected=calls.map(call=>expect(call).rejects.toBeInstanceOf(Error))
        await expect(f.client.recover()).rejects.toBeInstanceOf(Error)
        expect(f.packets).toHaveLength(8);await f.client.close();await Promise.all(rejected)
    })
    it('waits for protected host teardown during close and holds new admissions', async () => {
        let release!: () => void,finished=false
        const drained=new Promise<void>(yes=>{release=yes}),f=fixture(()=>drained)
        const call=f.client.executePrivately(),rejected=expect(call).rejects.toBeInstanceOf(Error)
        const close=f.client.close().then(()=>{finished=true})
        await Promise.resolve();expect(finished).toBe(false)
        await expect(f.client.recover()).rejects.toBeInstanceOf(Error)
        release();await close;await rejected;expect(f.packets).toHaveLength(1)
    })
    it('rejects incomplete target, unknown project or extra authority fields at construction', () => {
        const transport={readable:new PassThrough(),writable:new PassThrough(),drained:async()=>{}}
        expect(()=>createProtectedDocumentControlClient(transport,{...target,queueId:null},binding)).toThrow()
        expect(()=>createProtectedDocumentControlClient(transport,target,{...binding,approved:true} as any)).toThrow()
        expect(()=>createProtectedDocumentControlClient(transport,target,{...binding,association:{...binding.association,project:'unknown'}})).toThrow()
    })
    it('rejects duplicate JSON keys and oversized response frames', async () => {
        for (const wire of [JSON.stringify({protocol,type:'response',id:'document-1',result:capture}).slice(0,-1)+',"id":"document-1"}\n',
                            'x'.repeat(16385)]) {
            const f=fixture(),call=f.client.executePrivately()
            const rejected=expect(call).rejects.toMatchObject({outcomeUnknown:true})
            f.readable.write(wire);await rejected;expect(f.packets).toHaveLength(1)
        }
    })
})

// Hosted CI has no private canonical source. It runs all protocol cases above;
// this integration is mandatory locally with CANONICAL_PROJECT_SOURCE supplied.
describe.skipIf(!process.env.CANONICAL_PROJECT_SOURCE)('real private Node/Python document control connection', () => {
    it('executes privately, publishes explicitly, recovers without replay and proves control teardown', async () => {
        const child=spawn(process.env.CANONICAL_TEST_PYTHON || 'python3',
            ['-B',resolve('tests/fixtures/protected-document-control-host.py')],
            {env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe','pipe']})
        let stderr='',wire=''
        child.stderr!.on('data',bytes=>{stderr=(stderr+bytes).slice(-8192)})
        child.stdout!.on('data',bytes=>{wire+=bytes.toString()})
        const exited=new Promise<void>((yes,no)=>{
            child.on('error',no)
            child.on('close',(code,signal)=>code===0?yes():no(new Error(`Synthetic fixture exit ${code}/${signal}: ${stderr}`)))
        })
        void exited.catch(()=>{})
        try {
            const route=await new Promise<any>((yes,no)=>{
                let text=''
                child.stdio[3]!.on('data',bytes=>{text+=bytes.toString()})
                child.stdio[3]!.on('end',()=>{try{yes(JSON.parse(text))}catch(error){no(error)}})
                child.stdio[3]!.on('error',no)
            })
            expect(route.fixture_authority).toBe('SYNTHETIC')
            const client=createProtectedDocumentControlClient({readable:child.stdout!,writable:child.stdin!,drained:()=>exited},route.target,route.binding)
            owned.push(client)
            expect(existsSync(route.destination)).toBe(false)
            const captured=await client.executePrivately()
            expect(captured.result_digest).toBe(route.expected_digest);expect(captured.verified).toBe(false)
            expect(existsSync(route.destination)).toBe(false)
            expect(await client.recover()).toMatchObject({status:'PRIVATE_RESULT',replayed:false})
            const published=await client.publishDocument(captured.result_digest)
            expect(published.publication_scope).toBe('local-documentation-file')
            expect(readFileSync(route.destination,'utf8')).toMatch(/^# Gym NYC agent workflow proof/)
            expect(await client.recover()).toEqual(published)
            await client.close()
            expect(wire).not.toContain('# Gym NYC agent workflow proof')
        } finally {
            child.stdin!.end();await exited
        }
    },20000)
})
