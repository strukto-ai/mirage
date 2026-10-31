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
import gc
import logging
import threading
from collections import deque
from collections.abc import Awaitable, Callable, Coroutine, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from functools import partial, wraps
from typing import Any, Concatenate, ParamSpec, Protocol, TypeVar
from weakref import WeakKeyDictionary, WeakSet

from mirage.concurrency.limiter import run_blocking, settle

logger = logging.getLogger(__name__)

T = TypeVar("T")
AUXILIARY_LOOP: ContextVar[bool] = ContextVar(
    "mirage_auxiliary_loop", default=False
)
BLOCKED: WeakSet[asyncio.AbstractEventLoop] = WeakSet()
# Whether the garbage collector is running on this thread now, which
# ``gc.callbacks`` reports at a collection's start and stop.
COLLECTING = threading.local()
# What a collection put off on each loop (``defer``), in order.
DEFERRED: WeakKeyDictionary[
    asyncio.AbstractEventLoop, deque[Callable[[], None]]
] = WeakKeyDictionary()


def _on_collection(phase: str, info: dict[str, int]) -> None:
    COLLECTING.now = phase == "start"


gc.callbacks.append(_on_collection)


def collecting() -> bool:
    """Whether the garbage collector is running on this thread now.

    A finalizer it runs (a dropped file's close) may have interrupted
    anything, a drive of a shared loop included, so it neither drives
    one nor waits on one: it puts its work off (``defer``).
    """
    return bool(getattr(COLLECTING, "now", False))


def defer(loop: asyncio.AbstractEventLoop, work: Callable[[], None]) -> None:
    """Put off synchronous work that drives ``loop`` until something
    outside any drive of it runs ``run_deferred``: the next drive
    ``run_async_from_sync`` starts on it, or the workspace's close.

    Args:
        loop (asyncio.AbstractEventLoop): the loop the work drives.
        work (Callable[[], None]): what a finalizer could not do in place.
    """
    DEFERRED.setdefault(loop, deque()).append(work)


def run_deferred(loop: asyncio.AbstractEventLoop) -> None:
    """Run what was put off on ``loop``, in order, from a thread that is
    not driving it. A failure is logged and the rest still run.

    Args:
        loop (asyncio.AbstractEventLoop): the loop the work drives.
    """
    pending = DEFERRED.get(loop)
    while pending:
        work = pending.popleft()
        try:
            work()
        except Exception:
            logger.debug("work put off by a collection failed", exc_info=True)


@contextmanager
def blocking() -> Iterator[None]:
    """Mark the running loop as blocked by the synchronous call inside.

    A kernel mount answers on its workspace's loop. While that loop waits
    on a mount coming up or going down, whose path work can reach any of
    its mounts, their callbacks run on loops of their own rather than
    wait for it.
    """
    loop = asyncio._get_running_loop()
    if loop is None or loop in BLOCKED:
        yield
        return
    BLOCKED.add(loop)
    try:
        yield
    finally:
        BLOCKED.discard(loop)


async def _await_result(awaitable: Awaitable[T]) -> T:
    return await awaitable


def _run_in_new_loop(awaitable: Awaitable[T]) -> T:
    return asyncio.run(on_auxiliary_loop(partial(_await_result, awaitable)))


def run_async_from_sync(
    awaitable: Awaitable[T],
    loop: asyncio.AbstractEventLoop | None = None,
) -> T:
    """Call from a sync thread to run an async coroutine.

    A shared loop is honored whether or not something is driving it: a
    running one (FUSE, which serves it from its own thread) takes
    run_coroutine_threadsafe, an idle one (a ``with ws:`` block, whose
    caller is the only thread there is) is driven per call. Both keep
    every call on ONE loop, which is what a VFS holding a
    connection pool needs to still be closable at the end.

    Git's synchronous object readers also rely on the current-loop fallback
    for independent reads. Temporary loops are auxiliary to the caller's
    foreground owner. This fallback cannot safely wait on shared async
    locks; workspace agent adapters use ``SyncBridge`` instead.

    A call made while the garbage collector runs on this thread is
    refused: the collection may have interrupted a drive of that same
    loop, which driving it again from inside would end early (the nested
    run takes its stop), and waiting on it can block on itself. A file's
    finalizer puts its close off instead (``defer``), and an idle loop's
    next drive runs what was put off on it first.

    Args:
        awaitable (Awaitable[T]): The asynchronous operation to run.
        loop (asyncio.AbstractEventLoop | None): Shared event loop.
            If omitted, each call gets a throwaway loop.
    """
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None

    if loop is not None and loop.is_closed():
        if isinstance(awaitable, Coroutine):
            awaitable.close()
        raise RuntimeError("The owner event loop is closed")

    if loop is not None and collecting():
        if isinstance(awaitable, Coroutine):
            awaitable.close()
        raise RuntimeError(
            "a garbage collection cannot drive the loop it may have "
            "interrupted"
        )

    if loop is not None and loop is not running_loop:
        if loop.is_running():
            future = asyncio.run_coroutine_threadsafe(
                _await_result(awaitable), loop
            )
            return future.result()
        if running_loop is None:
            run_deferred(loop)
            return loop.run_until_complete(_await_result(awaitable))
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            return pool.submit(
                loop.run_until_complete, _await_result(awaitable)
            ).result()
    if running_loop is None:
        return _run_in_new_loop(awaitable)
    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        return pool.submit(_run_in_new_loop, awaitable).result()


async def _invoke(factory: Callable[[], Awaitable[T]]) -> T:
    return await factory()


async def on_auxiliary_loop(factory: Callable[[], Awaitable[T]]) -> T:
    """Run an internal callback without claiming foreground ownership.

    Args:
        factory (Callable[[], Awaitable[T]]): deferred callback on its
            temporary bridge loop or independent FUSE service loop.
    """
    token = AUXILIARY_LOOP.set(True)
    try:
        return await factory()
    finally:
        AUXILIARY_LOOP.reset(token)


def _serve_loop(loop: asyncio.AbstractEventLoop) -> None:
    with asyncio.Runner(loop_factory=lambda: loop) as runner:
        runner.get_loop().run_forever()


class SyncBridge:
    """Workspace-owned scheduling for synchronous agent tools.

    Foreground calls establish ownership without changing the dispatcher's
    threading contract. A synchronous application or context gets one loop
    thread, whose lifetime ends with the workspace. Auxiliary bridge reads
    and FUSE callbacks never replace that foreground owner.
    """

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._context_loop: asyncio.AbstractEventLoop | None = None
        self._ambiguous = False
        self._closing = False
        self._stop_requested = False
        self._lock = threading.Lock()
        self._shutdown_lock = threading.Lock()

    @property
    def loop(self) -> asyncio.AbstractEventLoop | None:
        """The owner: the loop foreground calls and synchronous tools run
        on, None until one does."""
        return self._loop

    def observe(self, loop: asyncio.AbstractEventLoop | None = None) -> None:
        """Record a foreground operation before it touches async state.

        Args:
            loop (asyncio.AbstractEventLoop | None): explicit host loop,
                otherwise the caller's running loop, if any.
        """
        if AUXILIARY_LOOP.get():
            return
        if loop is None:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                return
        with self._lock:
            if loop is self._context_loop and loop is not self._loop:
                return
            if self._loop is None:
                self._loop = loop
            elif self._loop is not loop:
                self._ambiguous = True

    def attach(self) -> None:
        """Use an adapter constructor's loop only when no owner is known."""
        if AUXILIARY_LOOP.get():
            return
        try:
            current = asyncio.get_running_loop()
        except RuntimeError:
            return
        with self._lock:
            if self._loop is None:
                self._loop = current

    def _start_locked(self) -> None:
        self._loop = asyncio.new_event_loop()
        ready = threading.Event()
        self._loop.call_soon(ready.set)
        self._thread = threading.Thread(
            target=_serve_loop,
            args=(self._loop,),
            name="mirage-sync",
            daemon=True,
        )
        self._thread.start()
        ready.wait()

    def context_loop(self) -> asyncio.AbstractEventLoop:
        """Keep a context-first workspace's owner running between calls.

        An existing async host keeps its owner; the synchronous file patch
        uses a separate context loop, which is auxiliary to that owner.
        """
        with self._lock:
            if self._closing:
                raise RuntimeError("Workspace is closed")
            if self._thread is threading.current_thread():
                raise RuntimeError(
                    "Use async file operations on the workspace owner event loop"
                )
            if self._loop is None:
                self._start_locked()
            if self._thread is not None:
                assert self._loop is not None
                self._context_loop = self._loop
            else:
                self._context_loop = asyncio.new_event_loop()
            return self._context_loop

    def _submit_locked(
        self, factory: Callable[[], Awaitable[T]], *, teardown: bool = False
    ) -> concurrent.futures.Future[T]:
        """Queue before stop can be requested, so Runner sees every task.

        Args:
            factory (Callable[[], Awaitable[T]]): deferred operation, invoked
                on the owner only after submission has been accepted.
            teardown (bool): admit idempotent teardown while closing.
        """
        loop = self._loop
        if not teardown and self._ambiguous:
            raise RuntimeError(
                "Workspace has been used on multiple event loops"
            )
        if (
            self._stop_requested
            or loop is None
            or loop.is_closed()
            or not loop.is_running()
        ):
            raise RuntimeError("The workspace owner event loop is not running")
        if not teardown:
            if self._closing:
                raise RuntimeError("Workspace is closing")
        pending = _invoke(factory)
        try:
            return asyncio.run_coroutine_threadsafe(pending, loop)
        except BaseException:
            pending.close()
            raise

    def run(self, factory: Callable[[], Awaitable[T]], async_name: str) -> T:
        """Invoke a tool without blocking its owner or racing loop shutdown.

        Args:
            factory (Callable[[], Awaitable[T]]): deferred async tool call.
            async_name (str): async alternative named in refusal errors.
        """
        try:
            current = asyncio.get_running_loop()
        except RuntimeError:
            current = None
        with self._lock:
            if self._closing and self._loop is None:
                raise RuntimeError("Workspace is closing")
            if self._loop is None:
                if current is not None:
                    self._loop = current
                else:
                    self._start_locked()
            if self._loop is current:
                raise RuntimeError(
                    "Cannot call a synchronous tool on its owner event loop; "
                    f"use await {async_name}(...)"
                )
            future = self._submit_locked(factory)
        return future.result()

    async def close(self, factory: Callable[[], Awaitable[None]]) -> None:
        """Close admission before scheduling teardown on a live owner.

        Args:
            factory (Callable[[], Awaitable[None]]): workspace teardown.
        """
        current = asyncio.get_running_loop()
        with self._lock:
            self._closing = True
            loop = self._loop
            if (
                loop is not None
                and (self._thread is not None or not self._ambiguous)
                and not self._stop_requested
                and loop is not current
                and not loop.is_closed()
                and loop.is_running()
            ):
                future = self._submit_locked(factory, teardown=True)
            else:
                future = None
        if future is None:
            await factory()
            return
        closing = asyncio.wrap_future(future)
        try:
            await asyncio.shield(closing)
        except asyncio.CancelledError:
            await settle(closing)
            raise

    def close_sync(
        self,
        factory: Callable[[], Awaitable[None]],
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        """Admit context teardown atomically with managed-loop shutdown.

        Args:
            factory (Callable[[], Awaitable[None]]): workspace teardown.
            loop (asyncio.AbstractEventLoop): the context's file-operation loop.
        """
        with self._lock:
            self._closing = True
            if loop is self._loop and self._thread is not None:
                if threading.current_thread() is self._thread:
                    raise RuntimeError(
                        "Cannot exit a synchronous context on its owner loop"
                    )
                future = self._submit_locked(factory, teardown=True)
            else:
                future = None
        if future is None:
            run_async_from_sync(_invoke(factory), loop)
        else:
            future.result()

    async def arun(self, factory: Callable[[], Awaitable[T]]) -> T:
        """Keep async adapter calls on their established owner too.

        Cross-loop cancellation reaches the owner task without cancelling
        its completion future, so cleanup still finishes before we return.

        Args:
            factory (Callable[[], Awaitable[T]]): deferred async tool call.
        """
        task: asyncio.Task[Any] | None = None
        cancel_requested = False

        async def invoke() -> T:
            nonlocal task
            if cancel_requested:
                raise asyncio.CancelledError
            task = asyncio.current_task()
            return await factory()

        def cancel() -> None:
            nonlocal cancel_requested
            cancel_requested = True
            if task is not None:
                task.cancel()

        current = asyncio.get_running_loop()
        with self._lock:
            if self._closing:
                raise RuntimeError("Workspace is closing")
            if self._loop is None:
                self._loop = current
            loop = self._loop
            future = None if loop is current else self._submit_locked(invoke)
        if future is None:
            return await factory()
        completion = asyncio.wrap_future(future)
        try:
            return await asyncio.shield(completion)
        except asyncio.CancelledError:
            with self._lock:
                if not future.done() and not self._stop_requested:
                    loop.call_soon_threadsafe(cancel)
            await settle(completion)
            raise

    def _stop_after_task(self, task: asyncio.Future[Any]) -> None:
        self._request_stop()

    def _request_stop(self) -> None:
        with self._lock:
            assert self._loop is not None
            self._closing = True
            if not self._stop_requested and not self._loop.is_closed():
                self._stop_requested = True
                self._loop.call_soon_threadsafe(self._loop.stop)

    async def ashutdown(self) -> None:
        """Join off-loop, or stop an owned loop once its calling task settles."""
        if self._thread is threading.current_thread():
            task = asyncio.current_task()
            assert task is not None
            task.add_done_callback(self._stop_after_task)
        elif self._thread is not None:
            await run_blocking(self.shutdown)

    def shutdown(self) -> None:
        """Stop only a loop this bridge created; its runner drains tasks."""
        thread = self._thread
        if thread is None:
            return
        if threading.current_thread() is thread:
            raise RuntimeError("Cannot join the workspace owner from itself")
        with self._shutdown_lock:
            self._request_stop()
            thread.join()


class BridgeClient(Protocol):
    _sync_bridge: SyncBridge


Client = TypeVar("Client", bound=BridgeClient)
P = ParamSpec("P")


def on_owner_loop(
    method: Callable[Concatenate[Client, P], Coroutine[Any, Any, T]],
) -> Callable[Concatenate[Client, P], Coroutine[Any, Any, T]]:
    """Keep an adapter's async method on the same owner as its sync tools.

    Args:
        method (Callable): async adapter method; its signature is preserved
            because agent frameworks derive tool schemas from it.
    """

    @wraps(method)
    async def call(self: Client, *args: P.args, **kwargs: P.kwargs) -> T:
        return await self._sync_bridge.arun(
            partial(method, self, *args, **kwargs)
        )

    return call
