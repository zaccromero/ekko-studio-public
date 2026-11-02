import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { RecoveryRegistration } from '../../packages/server/src/modules/studio/services/group-chat/committed-result-recovery'

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
export function fixture(db: DatabaseSync, home: string, now = Date.now()) {
    const workspace = join(home, 'workspace'), requestId = 'personal-test-01'
    const root = join(workspace, 'profile-tasks', 'personal', requestId)
    mkdirSync(root, { recursive: true })
    const registry = join(home, 'committed-result-recovery', 'registrations')
    mkdirSync(registry, { recursive: true })
    const write = (name: string, data: unknown) => writeFileSync(join(root, name), JSON.stringify(data))
    for (const name of ['task.txt', 'delivery_readiness.py', 'recovery.py']) writeFileSync(join(root, name), 'pinned source')
    const contract = { version: 1, profile: 'personal', request_id: requestId,
        task_sha256: sha('pinned source'), checker_sha256: sha('pinned source'), helper_sha256: sha('pinned source') }
    write('contract.json', contract)
    const contractSha256 = sha(readFileSync(join(root, 'contract.json')))
    write('started.json', { request_id: requestId, execution_id: 'execution-one', contract_sha256: contractSha256 })
    write('sample.json', { evidence_kind: 'live_public_health' })
    write('result.json', { status: 'BLOCKED', reason: 'transport off' })
    const commit = { request_id: requestId, execution_id: 'execution-one', contract_sha256: contractSha256,
        exit_code: 1, evaluated_at_utc: new Date(now - 2000).toISOString(), hashes: {
            'sample.json': sha(readFileSync(join(root, 'sample.json'))), 'result.json': sha(readFileSync(join(root, 'result.json'))),
        } }
    write('commit.json', commit)
    const reg: RecoveryRegistration = { version: 1, profile: 'personal', requestId, roomId: 'room', ownerAuthUserId: 1,
        messageId: 'source', queueId: 'queue', targetAgentId: 'worker', workspace, contractSha256 }
    const saveReg = () => writeFileSync(join(registry, 'task.json'), JSON.stringify(reg))
    saveReg()
    db.prepare('INSERT INTO gc_rooms (id,name,workspace,ownerAuthUserId,createdAt) VALUES (?,?,?,?,?)').run('room', 'Room', workspace, 1, now - 5000)
    db.prepare(`INSERT INTO gc_messages (id,roomId,senderId,senderName,role,content,timestamp) VALUES ('source','room','auth:1','Owner','user','task',?)`).run(now - 4000)
    db.prepare(`INSERT INTO gc_room_agents (id,roomId,agentId,name,agent,profile,removedAt) VALUES ('agent-record','room','worker','Worker','codex','default',0)`).run()
    db.prepare(`INSERT INTO gc_execution_queue (id,roomId,messageId,targetAgentId,targetAgentName,requesterMemberId,textSummary,sequence,status,createdAt,startedAt,finishedAt)
        VALUES ('queue','room','source','worker','Worker','auth:1','task',1,'failed',?,?,?)`).run(now - 4000, now - 3000, now - 1000)
    const error = 'Error: Coding agent session closed'
    db.prepare(`INSERT INTO gc_messages (id,roomId,senderId,senderName,role,content,timestamp,finish_reason) VALUES ('error','room','worker','Worker','assistant',?,?,'error')`).run(error, now - 1000)
    return { root, registry, reg, saveReg, write, commit, error, now }
}
