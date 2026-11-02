"""Explicit private-pipe connection to the canonical async backend; no launcher.

Import canonical modules from the protected host's configured source, never from
message fields. Only trusted composition supplies routes, factory and identities.
"""
import asyncio
import base64
from dataclasses import dataclass
import hashlib
import json
from types import MappingProxyType

import project_binding as binding
import project_carrier as carrier
import project_invocation_host as canonical
from project_invocation_async import AsyncExecutor, AsyncInvocationHost

MAX_FRAME = 2 * 1024 * 1024
MAX_BYTES = 1024 * 1024


@dataclass(frozen=True)
class Route:
    target: canonical.Target
    association: carrier.Association
    raw_binding: dict
    payload: bytes


@dataclass(frozen=True)
class Identity:
    executor: str
    host: str
    profile: str


def _pairs(items):
    value = {}
    for key, item in items:
        binding.need(key not in value, 'DUPLICATE_CHANNEL_FIELD')
        value[key] = item
    return value


class CanonicalInvocationChannel:
    def __init__(self, factory, identities, routes, *, drain_on_disconnect=None):
        binding.need(type(identities) is dict and all(
            type(k) is str and binding.ID.fullmatch(k) and type(v) is Identity
            for k, v in identities.items()), 'FIXED_CHANNEL_IDENTITIES_REQUIRED')
        copied = {}
        for route in routes:
            binding.need(type(route) is Route and type(route.target) is canonical.Target,
                         'PROTECTED_CHANNEL_ROUTE_REQUIRED')
            raw = binding.parse(route.raw_binding)
            canonical.InvocationHost._association(raw, route.association)
            canonical.InvocationHost._payload(raw, route.payload)
            key = route.target.key()
            binding.need(key not in copied, 'DUPLICATE_CHANNEL_TARGET')
            copied[key] = Route(route.target, route.association, raw, route.payload)
        self._routes = MappingProxyType(copied)
        self._active = None
        self._lost = self._closing = self._served = False
        self._lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._drain = drain_on_disconnect
        self._write = None
        self._tasks = set()
        self._ids = set()
        def operation_for(agent):
            async def operation(payload):
                return await self._effect(agent, payload)
            return operation
        self._backend = AsyncInvocationHost(factory, {
            agent: AsyncExecutor(identity.executor, identity.host, identity.profile,
                                 operation_for(agent))
            for agent, identity in dict(identities).items()})

    async def _send(self, packet):
        wire = json.dumps(packet, separators=(',', ':'), allow_nan=False).encode() + b'\n'
        binding.need(len(wire) <= MAX_FRAME, 'CHANNEL_FRAME_TOO_LARGE')
        async with self._write_lock:
            await self._write(wire)

    @staticmethod
    def _target(raw):
        binding.need(type(raw) is dict and set(raw) ==
                     {'roomId', 'messageId', 'agentId', 'queueId'}, 'CHANNEL_TARGET_REQUIRED')
        target = canonical.Target(*(raw[k] for k in ('roomId','messageId','agentId','queueId')))
        target.key()
        return target

    @staticmethod
    def _wire_target(target):
        return dict(zip(('roomId','messageId','agentId','queueId'),
                        (target.room_id,target.message_id,target.agent_id,target.queue_id)))

    @staticmethod
    def _bound(route):
        raw = route.raw_binding
        return {'carrier': {'version': 1, 'binding_ref': raw['request_id'],
                            'binding_digest': binding.fingerprint(raw)},
                'association': dict(vars(route.association))}

    async def _effect(self, agent, payload):
        state = self._active
        binding.need(state is not None and state['route'].target.agent_id == agent and
                     payload == state['route'].payload, 'CHANNEL_EFFECT_IDENTITY_MISMATCH')
        binding.need(not self._lost, 'CHANNEL_UNAVAILABLE')
        state['emitted'] = True  # Even a failed write can have reached the peer.
        try:
            await self._send({'v': 1, 'type': 'effect', 'id': state['id'],
                'target': self._wire_target(state['route'].target),
                **self._bound(state['route']),
                'payload': base64.b64encode(payload).decode()})
        except Exception:
            self._lost = True
            await self._disconnected_effect(state)
        return await state['finished']

    async def _disconnected_effect(self, state):
        if state['finished'].done():
            return
        if 'drain' not in state:
            async def proof():
                if self._drain is not None:
                    try:
                        result = await self._drain(state['route'].target)
                        if result is None:
                            return
                    except Exception:
                        pass
                # Missing, failed or boolean "proof" never releases the fence.
                await asyncio.Future()
            state['drain'] = asyncio.create_task(proof())
        while True:
            try:
                await asyncio.shield(state['drain'])
                break
            except asyncio.CancelledError:
                # Caller cancellation is not external quiescence.
                continue
        if not state['finished'].done():
            state['finished'].set_exception(binding.OutcomeUnknown('CHANNEL_LOST_DO_NOT_RETRY'))

    async def _request(self, packet):
        ident = packet['id']
        try:
            async with self._lock:
                binding.need(not self._lost, 'CHANNEL_UNAVAILABLE')
                target = self._target(packet['target'])
                route = self._routes.get(target.key())
                binding.need(route is not None, 'CHANNEL_ROUTE_NOT_FOUND')
                method = packet['method']
                bound = self._bound(route)
                if method != 'resolve':
                    binding.need(carrier.parse(packet['carrier']) == bound['carrier'] and
                                 packet['association'] == bound['association'],
                                 'CHANNEL_BINDING_MISMATCH')
                if method == 'resolve':
                    saved = await self._backend.recover(target, association=route.association)
                    if saved.status == 'OUTCOME_UNKNOWN_DO_NOT_RETRY':
                        raise binding.OutcomeUnknown('CHANNEL_SAVED_OUTCOME_UNKNOWN')
                    result = bound
                elif method == 'recover':
                    saved = await self._backend.recover(target, association=route.association)
                    result = {'status': saved.status}
                    if saved.status == 'COMPLETED':
                        result.update(result=base64.b64encode(saved.result).decode(),
                                      result_digest=saved.result_digest)
                else:
                    state = {'id': ident, 'route': route, 'emitted': False,
                             'finished': asyncio.get_running_loop().create_future()}
                    self._active = state
                    try:
                        value = await self._backend.invoke(target, association=route.association)
                        result = {'status': 'COMPLETED',
                                  'result_digest': hashlib.sha256(value).hexdigest()}
                    finally:
                        self._active = None
                binding.need(not self._lost, 'CHANNEL_UNAVAILABLE')
                await self._send({'v': 1, 'type': 'response', 'id': ident, 'ok': True, 'value': result})
        except Exception as error:
            if not self._lost:
                await self._send({'v': 1, 'type': 'response', 'id': ident, 'ok': False,
                    'unknown': isinstance(error, binding.OutcomeUnknown),
                    'code': 'CANONICAL_INVOCATION_REJECTED'})

    def _settled(self, packet):
        state = self._active
        binding.need(state is not None and state['emitted'] and
                     packet['id'] == state['id'] and not state['finished'].done(),
                     'UNEXPECTED_CHANNEL_SETTLEMENT')
        if packet['ok'] is False:
            binding.need(set(packet) == {'v','type','id','ok'}, 'INVALID_CHANNEL_SETTLEMENT')
            state['finished'].set_exception(binding.OutcomeUnknown('REMOTE_EFFECT_FAILED'))
        else:
            binding.need(packet['ok'] is True and set(packet) == {'v','type','id','ok','result'} and
                         type(packet['result']) is str, 'INVALID_CHANNEL_SETTLEMENT')
            value = base64.b64decode(packet['result'], validate=True)
            binding.need(len(value) <= MAX_BYTES and base64.b64encode(value).decode() == packet['result'],
                         'BOUNDED_CHANNEL_RESULT_REQUIRED')
            state['finished'].set_result(value)

    async def serve(self, read, write):
        """Explicit host-owned stream pair. No network endpoint or agent API."""
        binding.need(not self._served, 'CHANNEL_ALREADY_SERVED')
        self._served, self._write = True, write
        closing = None
        try:
            for route in self._routes.values():
                await self._backend.bind(route.target, association=route.association,
                    raw_binding=route.raw_binding, payload=route.payload)
            await self._send({'v': 1, 'type': 'ready'})
            while True:
                reading = asyncio.create_task(read(MAX_FRAME + 1))
                if closing is not None:
                    done, _ = await asyncio.wait((reading, closing), return_when=asyncio.FIRST_COMPLETED)
                    if closing in done:
                        reading.cancel()
                        await asyncio.gather(reading, return_exceptions=True)
                        await closing
                        return
                wire = await reading
                binding.need(wire and len(wire) <= MAX_FRAME and wire.endswith(b'\n'),
                             'CHANNEL_CLOSED_OR_OVERSIZED')
                packet = json.loads(wire, object_pairs_hook=_pairs,
                                    parse_constant=lambda _: binding.need(False, 'INVALID_CHANNEL_JSON'))
                binding.need(type(packet) is dict and type(packet.get('v')) is int and packet['v'] == 1,
                             'INVALID_CHANNEL_VERSION')
                kind = packet.get('type')
                if kind == 'close':
                    binding.need(set(packet) == {'v','type'}, 'INVALID_CHANNEL_CLOSE')
                    binding.need(not self._closing, 'CHANNEL_ALREADY_CLOSING')
                    self._closing = True
                    async def close_after_settlement():
                        await asyncio.gather(*self._tasks)
                        await self._backend.aclose()
                        await self._send({'v': 1, 'type': 'closed'})
                    closing = asyncio.create_task(close_after_settlement())
                    continue
                if kind == 'settled':
                    self._settled(packet)
                    continue
                binding.need(not self._closing, 'CHANNEL_CLOSED')
                method = packet.get('method')
                fields = {'v','type','id','method','target'}
                if method in {'invoke','recover'}:
                    fields |= {'carrier','association'}
                binding.need(kind == 'request' and method in {'resolve','invoke','recover'} and
                             set(packet) == fields and type(packet.get('id')) is str and
                             binding.ID.fullmatch(packet['id']) and packet['id'] not in self._ids and
                             len(self._ids) < 2048 and len(self._tasks) < 64,
                             'INVALID_CHANNEL_REQUEST')
                self._ids.add(packet['id'])
                task = asyncio.create_task(self._request(packet))
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)
        finally:
            self._lost = True
            state = self._active
            if state is not None and state['emitted']:
                await self._disconnected_effect(state)
            await asyncio.gather(*self._tasks, return_exceptions=True)
            await self._backend.aclose()
