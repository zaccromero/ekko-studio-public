import type { DatabaseSync } from 'node:sqlite'
import { buildHermesHostedRoomDispatch, type HermesRoomTask } from './hermes-hosted-room-dispatch'
import {
  getHermesHostedRoomRun, markHermesAdmissionUnknown, recordHermesRunAdmission, recordHermesRunTerminal,
  reserveHermesHostedRoomRun,
} from './hermes-hosted-room-ledger'
import { HermesRoomGrantClient, selectHermesRoomEndpoint, type ExpectedHermesRoomTarget, type HermesRoomIdentity } from './hermes-room-grant-client'
import { classifyHermesRun, HermesRunApiClient, type HermesRunAdmission, type HermesRunStatus } from './hermes-run-api-client'

export class HermesHostedRoomPendingError extends Error {
  readonly outcomeUnknown = true
  constructor(readonly runId: string, reason: string) {
    super(`Hermes VM run ${runId} remains open: ${reason}`)
    this.name = 'HermesHostedRoomPendingError'
  }
}

function validateReadbackLimits(maxWaitMs?: number, pollIntervalMs?: number): void {
  if (maxWaitMs !== undefined && (!Number.isSafeInteger(maxWaitMs) || maxWaitMs <= 0)) {
    throw new Error('Invalid Hermes hosted-room readback deadline')
  }
  if (pollIntervalMs !== undefined && (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0)) {
    throw new Error('Invalid Hermes hosted-room poll interval')
  }
}

/** One admission followed by status reads; never starts another task after uncertainty. */
export class HermesHostedRoomCoordinator {
  constructor(
    private readonly db: DatabaseSync,
    private readonly grantClient: HermesRoomGrantClient,
    private readonly transport: typeof fetch = fetch,
  ) {}

  async executeAndWait(input: {
    identity: HermesRoomIdentity
    target: ExpectedHermesRoomTarget
    queueId: string
    messageId: string
    targetAgentId: string
    task: HermesRoomTask
    maxWaitMs?: number
    pollIntervalMs?: number
  }): Promise<HermesRunStatus> {
    if (input.task.taskId !== input.queueId) throw new Error('Hermes hosted-room task ID must be the queue ID')
    validateReadbackLimits(input.maxWaitMs, input.pollIntervalMs)
    if (getHermesHostedRoomRun(this.db, input.queueId)) {
      throw new Error('Hermes hosted-room task already reserved; do not submit again')
    }
    const invitation = await this.grantClient.issue(input.identity)
    const bound = buildHermesHostedRoomDispatch(input.identity, invitation, input.target, input.task)
    reserveHermesHostedRoomRun(this.db, {
      queueId: input.queueId,
      roomId: input.identity.room_id,
      messageId: input.messageId,
      targetAgentId: input.targetAgentId,
      taskId: input.task.taskId,
      generation: input.task.executionGeneration,
      sourceEventSeq: input.task.sourceEventSeq,
      promptDigest: bound.dispatch.prompt_digest,
      scopeJson: JSON.stringify({ identity: input.identity, target: input.target }),
    }, true)
    const client = new HermesRunApiClient(bound.endpointUrl, () => bound.grant, this.transport)
    let admission: HermesRunAdmission
    try {
      admission = await client.submitRoomDispatch(bound.dispatch)
    } catch (error) {
      markHermesAdmissionUnknown(this.db, input.queueId)
      throw error
    }
    recordHermesRunAdmission(this.db, input.queueId, admission.run_id)
    return this.readKnownRun(client, input.queueId, admission.run_id, invitation.status_expires_at,
      input.maxWaitMs, input.pollIntervalMs)
  }

  /** Restart readback of an admitted run. This path makes no VM submission. */
  async resumeKnownRun(input: {
    queueId: string
    identity: HermesRoomIdentity
    target: ExpectedHermesRoomTarget
    maxWaitMs?: number
    pollIntervalMs?: number
  }): Promise<HermesRunStatus> {
    validateReadbackLimits(input.maxWaitMs, input.pollIntervalMs)
    const row = getHermesHostedRoomRun(this.db, input.queueId)
    if (!row || row.state !== 'admitted' || !row.runId
        || row.scopeJson !== JSON.stringify({ identity: input.identity, target: input.target })) {
      throw new Error('Hermes hosted-room run is not admitted under this scope')
    }
    const invitation = await this.grantClient.issue(input.identity)
    const endpoint = selectHermesRoomEndpoint(invitation, input.target)
    const client = new HermesRunApiClient(endpoint.url, () => invitation.grant, this.transport)
    return this.readKnownRun(client, input.queueId, row.runId, invitation.status_expires_at,
      input.maxWaitMs, input.pollIntervalMs)
  }

  private async readKnownRun(
    client: HermesRunApiClient, queueId: string, runId: string, statusExpiresAt: number,
    maxWaitMs?: number, pollIntervalMs?: number,
  ): Promise<HermesRunStatus> {
    const maxWait = Math.min(maxWaitMs ?? 8 * 60_000, 60 * 60_000)
    const deadline = Math.min(Date.now() + maxWait, statusExpiresAt * 1000)
    const interval = Math.min(pollIntervalMs ?? 2_000, 30_000)
    while (Date.now() < deadline) {
      let status: HermesRunStatus
      try { status = await client.status(runId) }
      catch { throw new HermesHostedRoomPendingError(runId, 'status readback failed') }
      const disposition = classifyHermesRun(status)
      if (disposition === 'completed' || disposition === 'failed') {
        recordHermesRunTerminal(this.db, queueId, runId, disposition, status)
        return status
      }
      if (disposition === 'needs_approval') {
        throw new HermesHostedRoomPendingError(runId, 'approval is pending')
      }
      if (disposition === 'unknown') {
        throw new HermesHostedRoomPendingError(runId, 'unrecognized status')
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))))
    }
    throw new HermesHostedRoomPendingError(runId, 'readback deadline reached')
  }
}
