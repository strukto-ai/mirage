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
import logging
import os
import socket
import struct
import threading
import time
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from dataclasses import dataclass, fields
from typing import Any, TypeVar

from mirage.context.session_context import current_caller
from mirage.io.network import (
    NetworkRule,
    answers,
    named,
    relay_at,
    run_with_network,
    watch_network,
)
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


@dataclass(frozen=True, slots=True)
class _Ticket:
    ctx: NetworkContext
    egress: Egress
    context: contextvars.Context


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
        ctx, egress = ticket.ctx, ticket.egress
        policies = egress.policies
        assert policies is not None
        started = time.monotonic()
        try:
            passed, limit = await _on(
                egress, ticket.context, lambda: pre_network_gate(policies, ctx)
            )
        except PolicyDenied:
            _reset(writer)
            return
        sent_received = [0, 0]
        ended: NetworkEnd = "error"
        try:
            upstream = await _reach(ctx, egress.rule)
            if upstream is None:
                _reset(writer)
                return
            ended = await _relay(
                (reader, writer), upstream, limit, sent_received
            )
        finally:
            seen = {f.name: getattr(ctx, f.name) for f in fields(ctx)}
            result = NetworkResultContext(
                **seen,
                bytes_sent=sent_received[0],
                bytes_received=sent_received[1],
                seconds=time.monotonic() - started,
                ended=ended,
            )
            try:
                await _on(
                    egress,
                    ticket.context,
                    lambda: post_network_gate(policies, result, passed),
                )
            except Exception as exc:
                logger.debug("gateway: post_network failed: %s", exc)


async def _reach(
    ctx: NetworkContext, rule: NetworkRule | None
) -> tuple[asyncio.StreamReader, asyncio.StreamWriter] | None:
    """The server's side of a connection: the address the program asked
    for, else each other address its host's lookup answered that the
    rule lets, as the program would have tried them had its own connect
    failed; None when none answers.

    Args:
        ctx (NetworkContext): the connection.
        rule (NetworkRule | None): the workspace's rule.
    """
    others = (
        address
        for address in answers(ctx.host, ctx.port)
        if address != ctx.address
        and (rule is None or rule.lets(ctx.host, address, ctx.port))
    )
    for address in (ctx.address, *(others if ctx.host else ())):
        try:
            return await asyncio.open_connection(address, ctx.port)
        except OSError as exc:
            logger.debug("gateway: %s unreachable: %s", address, exc)
    return None


async def _relay(
    client: tuple[asyncio.StreamReader, asyncio.StreamWriter],
    upstream: tuple[asyncio.StreamReader, asyncio.StreamWriter],
    limit: Limit | None,
    counts: list[int],
) -> NetworkEnd:
    """Copy both ways until both sides end, counting each, and cut the
    connection with a reset once it passes ``limit``.

    Args:
        client (tuple): the program's side.
        upstream (tuple): the server's side.
        limit (Limit | None): the bytes and seconds it may take.
        counts (list[int]): bytes sent and received so far, kept here.
    """
    cap = limit.max_bytes if limit is not None else None
    deadline = limit.timeout_seconds if limit is not None else None

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
        async with asyncio.timeout(deadline):
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
    """Where ``sock`` connects: the gateway, holding where it was going,
    when a policy listens for the connection; else ``address`` itself.

    Args:
        sock (socket.socket): the connecting socket.
        address (Any): where the program connects it.

    Raises:
        PermissionError: EACCES, the workspace's rule refuses it.
    """
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
    if relay is None or sock.getsockname()[1] != 0:
        return address
    loopback = _LOOPBACK[sock.family]
    sock.bind((loopback, 0))
    gateway.expect(
        sock.family,
        sock.getsockname()[1],
        _Ticket(_opened(target, port), egress, contextvars.copy_context()),
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
