# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio
import concurrent.futures
import contextvars
import errno
import functools
import logging
import os
import socket
import struct
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextvars import ContextVar
from dataclasses import dataclass, fields, replace
from typing import Any, TypeVar

from mirage.context.session_context import current_caller
from mirage.io.network import (
    NetworkRule,
    answers,
    named,
    relay_at,
    routed,
    run_with_network,
    watch_network,
)
from mirage.io.stream import OutputStream
from mirage.policy.base import Policy
from mirage.policy.errors import PolicyDenied
from mirage.policy.policies import (
    Policies,
    post_network_gate,
    pre_network_gate,
)
from mirage.policy.types import (
    NetworkContext,
    NetworkEnd,
    NetworkResultContext,
)
from mirage.types import Limit

logger = logging.getLogger(__name__)

T = TypeVar("T")

# The loopback address each family's listener takes.
_LOOPBACK = {socket.AF_INET: "127.0.0.1", socket.AF_INET6: "::1"}


@dataclass(frozen=True, slots=True)
class Egress:
    """What judges the connections a line or a file op opens.

    Args:
        rule (NetworkRule | None): the workspace's ``network``, None for
            no limit.
        policies (Policies | None): the workspace's policies, whose
            pre_network and post_network each connection answers to.
        loop (asyncio.AbstractEventLoop): the loop those policies answer
            on.
        hooked (bool): whether a policy listens for the session's
            connections, so each one goes through the gateway.
    """

    rule: NetworkRule | None
    policies: Policies | None
    loop: asyncio.AbstractEventLoop
    hooked: bool


_egress: ContextVar[Egress | None] = ContextVar("mirage_egress", default=None)


async def _listens(policies: Policies | None) -> bool:
    if policies is None:
        return False
    session = current_caller().session
    sid = "" if session is None else session.session_id
    return any(
        [
            policies.wants(method) and await policies.wants_for(method, sid)
            for method in ("pre_network", "post_network")
        ]
    )


async def run_with_egress(
    rule: NetworkRule | None, policies: Policies | None, call: Awaitable[T]
) -> T:
    """``call`` awaited as a line or a file op of a workspace: every
    connection it opens clears ``rule``, and passes the gateway when a
    policy listens for the session's connections. Mirrors TS's
    ``runWithEgress``.

    Args:
        rule (NetworkRule | None): the workspace's rule, None for none.
        policies (Policies | None): the workspace's policies.
        call (Awaitable[T]): the line or the op.
    """
    _watch()
    outer = _egress.get()
    hooked = (
        outer.hooked
        if outer is not None and outer.policies is policies
        else await _listens(policies)
    )
    token = _egress.set(
        Egress(rule, policies, asyncio.get_running_loop(), hooked)
    )
    try:
        return await run_with_network(rule, call)
    finally:
        _egress.reset(token)


def live_egress() -> tuple[Egress, ...]:
    """The egress of the call running here, none outside a line or an
    op. A task keeps its own binding, so it is one; TS's ``liveEgress``
    answers every live call's in a browser, which cannot tell them
    apart."""
    egress = _egress.get()
    return () if egress is None else (egress,)


def with_egress(it: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """``it`` pulled and closed under the egress bound where it was made:
    a mount's stream opens each later connection, whoever pulls it and
    however late, under the workspace's rule and policies, as
    ``with_caller`` keeps its caller. Its close reaches the stream even
    before a first pull. Handed back as it is where neither limits
    anything. Mirrors TS's ``withEgress``.

    Args:
        it (AsyncIterator[bytes]): the stream.
    """
    live = live_egress()
    egress = live[-1] if live else None
    if egress is None or (egress.rule is None and not egress.hooked):
        return it
    bound = egress

    async def under(call: Awaitable[T]) -> T:
        token = _egress.set(bound)
        try:
            return await run_with_network(bound.rule, call)
        finally:
            _egress.reset(token)

    iterator = it.__aiter__()

    async def pulled() -> AsyncIterator[bytes]:
        while True:
            try:
                item = await under(iterator.__anext__())
            except StopAsyncIteration:
                return
            yield item

    async def close() -> None:
        aclose = getattr(iterator, "aclose", None)
        if aclose is not None:
            await under(aclose())

    return OutputStream(pulled(), close)


@dataclass(frozen=True, slots=True)
class _Ticket:
    ctx: NetworkContext
    egress: Egress
    context: contextvars.Context
    # The other addresses the opener's lookup of the host answered, which
    # the program would have tried had its own connect failed.
    others: tuple[str, ...]


def _opened(address: str, port: int) -> NetworkContext:
    caller = current_caller()
    invocation = caller.invocation
    mount = caller.vfs_mount or ""
    return NetworkContext(
        host=named(address, port),
        address=address,
        port=port,
        command=caller.command or "",
        program=invocation.program if invocation is not None else (),
        words=invocation.words if invocation is not None else (),
        line=invocation.line if invocation is not None else "",
        mount=mount.rstrip("/") or mount,
        session_id="" if caller.session is None else caller.session.session_id,
    )


async def _on(
    egress: Egress,
    context: contextvars.Context,
    make: Callable[[], Awaitable[T]],
) -> T:
    """``make()`` awaited on the loop the policies answer on, as the call
    that opened the connection.

    Args:
        egress (Egress): what judges the connection.
        context (contextvars.Context): the opener's context.
        make (Callable[[], Awaitable[T]]): the policy call.
    """
    done: concurrent.futures.Future[T] = concurrent.futures.Future()

    async def run() -> T:
        return await make()

    def settle(task: "asyncio.Task[T]") -> None:
        if task.cancelled():
            done.cancel()
        elif (exc := task.exception()) is not None:
            done.set_exception(exc)
        else:
            done.set_result(task.result())

    def start() -> None:
        egress.loop.create_task(run(), context=context).add_done_callback(
            settle
        )

    egress.loop.call_soon_threadsafe(start)
    return await asyncio.wrap_future(done)


def _reset(writer: asyncio.StreamWriter) -> None:
    sock = writer.get_extra_info("socket")
    if sock is not None:
        try:
            # Abort on close: the peer reads a reset, never a clean end,
            # so a cut transfer cannot pass for a whole one.
            sock.setsockopt(
                socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0)
            )
        except OSError as exc:
            logger.debug("gateway: no reset on close: %s", exc)
    writer.transport.abort()


class _Cut(Exception):
    """A connection carried past its Limit."""


class _Gateway:
    """The one relay each judged connection of the process passes: a
    listener per address family on loopback, served on its own thread
    so a blocked workspace loop never stalls another's connections.
    """

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.expected: dict[tuple[int, int], _Ticket] = {}
        self.lock = threading.Lock()
        self.ports: dict[int, int] = {}
        self.thread = threading.Thread(
            target=self.loop.run_forever, name="mirage-gateway", daemon=True
        )
        self.thread.start()
        # Started apart from the line that opened the first connection, so
        # the relay's own connections carry no egress of the line's.
        started: concurrent.futures.Future[None] = concurrent.futures.Future()

        def listen() -> None:
            task = self.loop.create_task(self._listen())
            task.add_done_callback(
                lambda done: (
                    started.set_exception(exc)
                    if (exc := done.exception()) is not None
                    else started.set_result(None)
                )
            )

        self.loop.call_soon_threadsafe(listen, context=contextvars.Context())
        started.result()

    async def _listen(self) -> None:
        for family, host in _LOOPBACK.items():
            try:
                server = await asyncio.start_server(
                    self._serve, host, 0, family=family
                )
            except OSError as exc:
                logger.debug("gateway: no %s listener: %s", host, exc)
                continue
            port = server.sockets[0].getsockname()[1]
            self.ports[family] = port
            relay_at(host, port)

    def expect(self, family: int, local: int, ticket: _Ticket) -> None:
        with self.lock:
            self.expected[(family, local)] = ticket

    async def _serve(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        sock = writer.get_extra_info("socket")
        peer = writer.get_extra_info("peername")
        with self.lock:
            ticket = self.expected.pop((sock.family, peer[1]), None)
        if ticket is None:
            _reset(writer)
            return
        try:
            await self._pass(ticket, reader, writer)
        except Exception as exc:
            logger.debug("gateway: connection to %s failed: %s", peer, exc)
            _reset(writer)

    async def _pass(
        self,
        ticket: _Ticket,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        egress, rule = ticket.egress, ticket.egress.rule
        policies = egress.policies
        assert policies is not None
        host, port = ticket.ctx.host, ticket.ctx.port
        others = (
            address
            for address in ticket.others
            if rule is None or rule.lets(host, address, port)
        )
        # Each address is a connection of its own: judged before it is
        # tried, and told how it went, the one reached or the ones that
        # failed on the way to it.
        for address in (ticket.ctx.address, *others):
            ctx = replace(ticket.ctx, address=address)
            try:
                passed, limit = await _on(
                    egress,
                    ticket.context,
                    functools.partial(pre_network_gate, policies, ctx),
                )
            except PolicyDenied as exc:
                logger.debug("gateway: %s refused: %s", address, exc)
                continue
            reached = await self._attempt(
                ticket, policies, ctx, passed, limit, (reader, writer)
            )
            if reached:
                return
        _reset(writer)

    async def _attempt(
        self,
        ticket: _Ticket,
        policies: Policies,
        ctx: NetworkContext,
        passed: tuple[Policy, ...] | None,
        limit: Limit | None,
        client: tuple[asyncio.StreamReader, asyncio.StreamWriter],
    ) -> bool:
        """One address tried and, once it answers, relayed under
        ``limit``, whose seconds count from the attempt; post_network
        hears how it went either way.

        Args:
            ticket (_Ticket): the connection.
            policies (Policies): what judges it.
            ctx (NetworkContext): this address's context.
            passed (tuple[Policy, ...] | None): who let it through.
            limit (Limit | None): what it may carry and for how long.
            client (tuple): the program's side.

        Returns:
            bool: whether the address answered.
        """
        started = time.monotonic()
        seconds = limit.timeout_seconds if limit is not None else None
        deadline = (
            None
            if seconds is None
            else asyncio.get_running_loop().time() + seconds
        )
        counts = [0, 0]
        ended: NetworkEnd = "error"
        reached = False
        try:
            async with asyncio.timeout_at(deadline):
                upstream = await asyncio.open_connection(ctx.address, ctx.port)
            reached = True
            ended = await _relay(client, upstream, limit, counts, deadline)
        except TimeoutError:
            ended = "limit"
            reached = True
            _reset(client[1])
        except OSError as exc:
            logger.debug("gateway: %s unreachable: %s", ctx.address, exc)
        finally:
            seen = {f.name: getattr(ctx, f.name) for f in fields(ctx)}
            result = NetworkResultContext(
                **seen,
                bytes_sent=counts[0],
                bytes_received=counts[1],
                seconds=time.monotonic() - started,
                ended=ended,
            )
            try:
                await _on(
                    ticket.egress,
                    ticket.context,
                    functools.partial(
                        post_network_gate, policies, result, passed
                    ),
                )
            except Exception as exc:
                logger.debug("gateway: post_network failed: %s", exc)
        return reached


async def _relay(
    client: tuple[asyncio.StreamReader, asyncio.StreamWriter],
    upstream: tuple[asyncio.StreamReader, asyncio.StreamWriter],
    limit: Limit | None,
    counts: list[int],
    deadline: float | None,
) -> NetworkEnd:
    """Copy both ways until both sides end, counting each, and cut the
    connection with a reset once it passes ``limit``'s bytes or the
    deadline its seconds set as the attempt began.

    Args:
        client (tuple): the program's side.
        upstream (tuple): the server's side.
        limit (Limit | None): the bytes it may carry.
        counts (list[int]): bytes sent and received so far, kept here.
        deadline (float | None): the loop time it must end by.
    """
    cap = limit.max_bytes if limit is not None else None

    async def pump(
        src: asyncio.StreamReader, dst: asyncio.StreamWriter, side: int
    ) -> None:
        while chunk := await src.read(64 * 1024):
            if cap is not None:
                left = cap - counts[0] - counts[1]
                if len(chunk) > left:
                    counts[side] += max(left, 0)
                    dst.write(chunk[: max(left, 0)])
                    raise _Cut
            counts[side] += len(chunk)
            dst.write(chunk)
            await dst.drain()
        if dst.can_write_eof():
            dst.write_eof()

    tasks = [
        asyncio.ensure_future(pump(client[0], upstream[1], 0)),
        asyncio.ensure_future(pump(upstream[0], client[1], 1)),
    ]
    ended: NetworkEnd = "closed"
    try:
        async with asyncio.timeout_at(deadline):
            for task in asyncio.as_completed(tasks):
                await task
    except (_Cut, TimeoutError):
        ended = "limit"
    except OSError as exc:
        logger.debug("gateway: relay broke: %s", exc)
        ended = "error"
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if ended == "closed":
            client[1].close()
            upstream[1].close()
        else:
            _reset(client[1])
            _reset(upstream[1])
    return ended


_gateway: _Gateway | None = None
_gateway_lock = threading.Lock()


def _started() -> _Gateway:
    global _gateway
    with _gateway_lock:
        if _gateway is None:
            _gateway = _Gateway()
        return _gateway


def _through(sock: socket.socket, address: Any) -> Any:
    """Where ``sock`` connects: the gateway, holding where it was going
    (where a route names, for a routed one), when a policy listens for
    the connection; else that end itself.

    Args:
        sock (socket.socket): the connecting socket.
        address (Any): where the program connects it.

    Raises:
        PermissionError: EACCES, the workspace's rule refuses it.
    """
    address = routed(sock, address)
    live = live_egress()
    egress = live[-1] if live else None
    if (
        egress is None
        or not egress.hooked
        or sock.family not in _LOOPBACK
        or sock.type != socket.SOCK_STREAM
        or not isinstance(address, tuple)
        or not isinstance(address[0], str)
        or not isinstance(address[1], int)
    ):
        return address
    target, port = address[0], address[1]
    if egress.rule is not None and not egress.rule.connects(target, port):
        raise PermissionError(errno.EACCES, os.strerror(errno.EACCES))
    gateway = _started()
    relay = gateway.ports.get(sock.family)
    # A socket the program already bound, or a family the gateway has no
    # listener for, cannot be relayed, so a policy could not judge it.
    if relay is None or sock.getsockname()[1] != 0:
        raise PermissionError(errno.EACCES, os.strerror(errno.EACCES))
    loopback = _LOOPBACK[sock.family]
    sock.bind((loopback, 0))
    ctx = _opened(target, port)
    gateway.expect(
        sock.family,
        sock.getsockname()[1],
        _Ticket(
            ctx,
            egress,
            contextvars.copy_context(),
            tuple(
                address
                for address in (answers(ctx.host, port) if ctx.host else ())
                if address != target
            ),
        ),
    )
    return (loopback, relay, *address[2:])


_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex
_watching = False
_watch_lock = threading.Lock()


def _connecting(sock: socket.socket, address: Any) -> None:
    _connect(sock, _through(sock, address))


def _connecting_ex(sock: socket.socket, address: Any) -> int:
    return _connect_ex(sock, _through(sock, address))


def _watch() -> None:
    """Send every connection the process opens through ``_through``,
    once; one with no egress bound connects as asked."""
    global _watching
    with _watch_lock:
        if _watching:
            return
        _watching = True
        watch_network()
        setattr(socket.socket, "connect", _connecting)
        setattr(socket.socket, "connect_ex", _connecting_ex)
