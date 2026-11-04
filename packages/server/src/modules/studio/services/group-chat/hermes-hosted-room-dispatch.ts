import { createHash } from 'node:crypto'
import { selectHermesRoomEndpoint, type ExpectedHermesRoomTarget, type HermesRoomIdentity, type HermesRoomInvitation } from './hermes-room-grant-client'
import { HERMES_HOSTED_ROOM_PROTOCOL_VERSION, type HermesHostedRoomDispatch } from './hermes-run-api-client'

export type HermesRoomTask = {
  taskId: string
  executionGeneration: number
  sourceEventSeq: number
  cancellationScopeId: string
  prompt: string
  traceId: string
}

/** Bind one authorized room task to one scoped invitation before network admission. */
export function buildHermesHostedRoomDispatch(
  identity: HermesRoomIdentity,
  invitation: HermesRoomInvitation,
  target: ExpectedHermesRoomTarget,
  task: HermesRoomTask,
): { endpointUrl: string; grant: string; dispatch: HermesHostedRoomDispatch } {
  const endpoint = selectHermesRoomEndpoint(invitation, target)
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/
  if (![identity.room_id, identity.home_install_id, identity.authority_gateway_id,
    identity.member_id, target.installId, target.profile, task.taskId,
    task.cancellationScopeId, task.traceId].every(value => identifier.test(value))
    || !Number.isSafeInteger(identity.authority_epoch) || identity.authority_epoch <= 0
    || !Number.isSafeInteger(task.executionGeneration) || task.executionGeneration <= 0
    || !Number.isSafeInteger(task.sourceEventSeq) || task.sourceEventSeq <= 0
    || !task.prompt.trim()) {
    throw new Error('Invalid Hermes hosted-room task binding')
  }
  const dispatch: HermesHostedRoomDispatch = {
    protocol_version: HERMES_HOSTED_ROOM_PROTOCOL_VERSION,
    room_id: identity.room_id,
    home_install_id: identity.home_install_id,
    authority_gateway_id: identity.authority_gateway_id,
    authority_epoch: identity.authority_epoch,
    member_id: identity.member_id,
    target_install_id: target.installId,
    target_profile: target.profile,
    task_id: task.taskId,
    execution_generation: task.executionGeneration,
    source_event_seq: task.sourceEventSeq,
    cancellation_scope_id: task.cancellationScopeId,
    prompt: task.prompt,
    prompt_digest: createHash('sha256').update(task.prompt, 'utf8').digest('hex'),
    capability_digest: endpoint.catalogDigest,
    execution_policy_digest: endpoint.executionPolicyDigest,
    trace_id: task.traceId,
  }
  return { endpointUrl: endpoint.url, grant: invitation.grant, dispatch }
}
