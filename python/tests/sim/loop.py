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
import selectors
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Any, Final, TypeVar

T = TypeVar("T")

SIM_EPOCH: Final = 1_767_225_600.0
HORIZON_SECONDS: Final = 86_400.0
MAX_TURNS: Final = 100_000


@dataclass(frozen=True, slots=True)
class TaskDump:
    """One unfinished task as a deadlock report shows it."""

    name: str
    stack: tuple[str, ...]


class Stuck(RuntimeError):
    """A run that cannot finish, with every unfinished task's stack.

    Args:
        why (str): what stopped it.
        at (float): the virtual time it was detected at.
        tasks (tuple[TaskDump, ...]): every unfinished task.
        held (tuple[str, ...]): every request waiting at a hold.
    """

    def __init__(
        self,
        why: str,
        at: float,
        tasks: tuple[TaskDump, ...],
        held: tuple[str, ...],
    ) -> None:
        self.at = at
        self.tasks = tasks
        self.held = held
        lines = [f"{why} at t={at:.6f}: {len(tasks)} task(s) unfinished"]
        for task in tasks:
            lines.append(f"  task {task.name}")
            lines.extend(f"    {frame}" for frame in task.stack)
        lines.extend(f"  held: {h}" for h in held)
        super().__init__("\n".join(lines))


class Deadlock(Stuck):
    """Nothing is runnable, no timer is pending, and work is unfinished."""


class Stall(Stuck):
    """The virtual horizon or the turn cap passed with work unfinished."""


class _VirtualSelector(selectors.BaseSelector):
    """Real registration, virtual waiting.

    The loop asks its selector to wait ``timeout`` seconds whenever
    nothing is ready. This one advances virtual time by exactly that
    instead, so time jumps from timer to timer and computing costs none.
    Only the loop's own self-pipe may register, while the loop is built.

    Args:
        loop (SimLoop): the loop this selector serves.
        max_turns (int): how many loop turns a run may take.
    """

    def __init__(self, loop: "SimLoop", max_turns: int) -> None:
        self._loop = loop
        self._inner = selectors.DefaultSelector()
        self.now = 0.0
        self.turns = 0
        self.max_turns = max_turns
        self.cap = max_turns
        self.sealed = False

    def register(
        self, fileobj: Any, events: int, data: Any = None
    ) -> selectors.SelectorKey:
        """Delegate while the loop is built, refuse afterwards.

        Args:
            fileobj (Any): the file the loop would watch.
            events (int): the event mask.
            data (Any): the loop's callback data.
        """
        if self.sealed:
            raise RuntimeError(f"real I/O inside the simulator: {fileobj!r}")
        return self._inner.register(fileobj, events, data)

    def modify(
        self, fileobj: Any, events: int, data: Any = None
    ) -> selectors.SelectorKey:
        """Delegate, so the self-pipe keeps its registration.

        Args:
            fileobj (Any): the watched file.
            events (int): the new event mask.
            data (Any): the loop's callback data.
        """
        return self._inner.modify(fileobj, events, data)

    def unregister(self, fileobj: Any) -> selectors.SelectorKey:
        """Delegate.

        Args:
            fileobj (Any): the watched file.
        """
        return self._inner.unregister(fileobj)

    def select(
        self, timeout: float | None = None
    ) -> list[tuple[selectors.SelectorKey, int]]:
        """Answer the loop's poll without waiting.

        The loop polls once per turn, so ``turns`` counts every turn,
        and a task spinning on zero-delay yields is a ``Stall`` too.

        Args:
            timeout (float | None): what the loop would block for: 0
                when a callback is ready, the gap to its next timer, or
                None when it has no timer.
        """
        self.turns += 1
        if self.turns > self.cap:
            raise self._stuck(Stall, f"{self.max_turns} loop turns")
        ready = self._inner.select(0)
        if ready or timeout == 0:
            return ready
        if self._loop.on_idle():
            return []
        if timeout is None:
            raise self._stuck(Deadlock, "deadlock")
        self.now += timeout
        if self.now > HORIZON_SECONDS:
            raise self._stuck(
                Stall, f"past the {HORIZON_SECONDS:.0f} s horizon"
            )
        return []

    def _stuck(self, kind: type[Stuck], why: str) -> Stuck:
        return kind(why, self.now, self._loop.dump(), self._loop.held())

    def close(self) -> None:
        """Close the real selector under it."""
        self._inner.close()

    def get_key(self, fileobj: Any) -> selectors.SelectorKey:
        """Delegate.

        Args:
            fileobj (Any): the watched file.
        """
        return self._inner.get_key(fileobj)

    def get_map(self) -> Any:
        """Delegate."""
        return self._inner.get_map()


class LagExecutor(concurrent.futures.ThreadPoolExecutor):
    """The loop's default executor: each job runs on the loop thread.

    A job runs after a virtual lag, so a ``to_thread`` call becomes an
    ordered scheduling point instead of a thread. No thread is started,
    and a job cancelled during its lag never runs, as in a real pool.

    Args:
        loop (SimLoop): the loop it schedules on.
        lag (Callable[[int], float]): the lag of the nth job.
    """

    def __init__(self, loop: "SimLoop", lag: Callable[[int], float]) -> None:
        super().__init__(max_workers=1)
        self._sim_loop = loop
        self._lag = lag
        self._jobs = 0

    def submit(
        self, fn: Callable[..., T], /, *args: Any, **kwargs: Any
    ) -> concurrent.futures.Future[T]:
        """Run ``fn`` on the loop after its lag; return its future.

        Args:
            fn (Callable[..., T]): the blocking function.
            args (Any): its positional arguments.
            kwargs (Any): its keyword arguments.
        """
        future: concurrent.futures.Future[T] = concurrent.futures.Future()

        def run() -> None:
            if not future.set_running_or_notify_cancel():
                return
            try:
                future.set_result(fn(*args, **kwargs))
            except BaseException as exc:
                future.set_exception(exc)

        self._sim_loop.call_later(self._lag(self._jobs), run)
        self._jobs += 1
        return future

    def shutdown(
        self, wait: bool = True, *, cancel_futures: bool = False
    ) -> None:
        """No thread was started, so nothing is joined.

        Args:
            wait (bool): ignored.
            cancel_futures (bool): ignored.
        """
        del wait, cancel_futures


def _no_lag(nth: int) -> float:
    del nth
    return 0.0


def _awaiting(task: asyncio.Task[Any]) -> tuple[str, ...]:
    frames = []
    coro: Any = task.get_coro()
    while coro is not None:
        frame = getattr(coro, "cr_frame", None) or getattr(
            coro, "gi_frame", None
        )
        if frame is None:
            break
        code = frame.f_code
        where = "/".join(code.co_filename.rsplit("/", 2)[-2:])
        frames.append(f"{where}:{frame.f_lineno} {code.co_name}")
        coro = getattr(coro, "cr_await", None) or getattr(
            coro, "gi_yieldfrom", None
        )
    return tuple(frames)


class SimLoop(asyncio.SelectorEventLoop):
    """Real asyncio with virtual time.

    Overrides only the public ``time()`` and injects a selector, so the
    ready queue keeps asyncio's FIFO order and no private loop name is
    touched. Order comes from timers alone.

    Args:
        lag (Callable[[int], float]): the lag of the nth blocking job.
        max_turns (int): how many loop turns a run may take.
    """

    def __init__(
        self,
        lag: Callable[[int], float] = _no_lag,
        max_turns: int = MAX_TURNS,
    ) -> None:
        self.timeline = _VirtualSelector(self, max_turns)
        self._settling: list[asyncio.Future[None]] = []
        self._idle_hooks: list[Callable[[], bool]] = []
        self._held_hooks: list[Callable[[], tuple[str, ...]]] = []
        super().__init__(selector=self.timeline)
        self.timeline.sealed = True
        self.set_default_executor(LagExecutor(self, lag))

    def time(self) -> float:
        """Virtual seconds since the loop was built."""
        return self.timeline.now

    async def settle(self) -> None:
        """Return once nothing is runnable at this instant.

        Never advances time, so a held request is not cut short by a
        deadline meanwhile. A timer due later, however soon (a request
        leg, a lag, a 1 us yield), is still pending when it returns.
        """
        waiter = self.create_future()
        self._settling.append(waiter)
        await waiter

    def watch_idle(
        self,
        hook: Callable[[], bool],
        held: Callable[[], tuple[str, ...]],
    ) -> None:
        """Ask to be told whenever nothing is runnable at this instant.

        Args:
            hook (Callable[[], bool]): called before time would advance
                or a deadlock be raised; returns whether it made
                something runnable.
            held (Callable[[], tuple[str, ...]]): what it holds, for a
                deadlock report.
        """
        self._idle_hooks.append(hook)
        self._held_hooks.append(held)

    def on_idle(self) -> bool:
        """Wake settle waiters, else idle hooks; whether any woke."""
        if self._settling:
            waiters, self._settling = self._settling, []
            for waiter in waiters:
                if not waiter.done():
                    waiter.set_result(None)
            return True
        return any([hook() for hook in self._idle_hooks])

    def held(self) -> tuple[str, ...]:
        """Everything an idle hook still holds."""
        return tuple(h for held in self._held_hooks for h in held())

    def dump(self) -> tuple[TaskDump, ...]:
        """Every unfinished task and the awaits it is suspended in."""
        tasks = asyncio.all_tasks(self)
        dumps = (TaskDump(t.get_name(), _awaiting(t)) for t in tasks)
        return tuple(sorted(dumps, key=lambda d: d.name))


class SimClock:
    """The workspace ``Clock`` as a view of the loop.

    ``SimClock``, every asyncio timer and the loop all read one time.

    Args:
        loop (SimLoop): the run's loop.
        epoch (float): the wall time at virtual zero.
    """

    def __init__(self, loop: SimLoop, epoch: float = SIM_EPOCH) -> None:
        self._loop = loop
        self._epoch = epoch

    def now(self) -> float:
        """Wall seconds: the epoch plus virtual time."""
        return self._epoch + self._loop.time()

    def monotonic(self) -> float:
        """Virtual seconds."""
        return self._loop.time()

    async def sleep(self, seconds: float) -> None:
        """Wait on a virtual timer, so concurrent sleeps overlap.

        Args:
            seconds (float): how long to wait; zero or less returns at
                once.
        """
        await asyncio.sleep(max(0.0, seconds))


async def _cancel_all() -> list[BaseException]:
    left = asyncio.all_tasks() - {asyncio.current_task()}
    for task in left:
        task.cancel()
    results = await asyncio.gather(*left, return_exceptions=True)
    return [
        r
        for r in results
        if isinstance(r, BaseException)
        and not isinstance(r, asyncio.CancelledError)
    ]


def _teardown(loop: SimLoop, finished: bool) -> None:
    left = sorted(t.get_name() for t in asyncio.all_tasks(loop))
    loop.timeline.cap = loop.timeline.turns + loop.timeline.max_turns
    failed = loop.run_until_complete(_cancel_all())
    if failed:
        raise ExceptionGroup("tasks failed while cancelled", failed)
    if finished and left:
        raise RuntimeError(f"tasks outlived the program: {left}")


def run(
    main: Coroutine[Any, Any, T],
    lag: Callable[[int], float] = _no_lag,
    max_turns: int = MAX_TURNS,
) -> tuple[T, SimLoop]:
    """Run ``main`` on a fresh ``SimLoop``, then close it.

    A task still pending when ``main`` returns is an error, and so is a
    task that fails while it is cancelled. When ``main`` itself failed,
    the teardown's failure is noted on that error instead of hiding it.

    Args:
        main (Coroutine[Any, Any, T]): the program.
        lag (Callable[[int], float]): the lag of the nth blocking job.
        max_turns (int): how many loop turns the run may take.
    """
    loop = SimLoop(lag, max_turns)
    try:
        try:
            result = loop.run_until_complete(main)
        except BaseException as exc:
            try:
                _teardown(loop, finished=False)
            except BaseException as during:
                exc.add_note(f"during teardown: {during!r}")
            raise
        _teardown(loop, finished=True)
        return result, loop
    finally:
        loop.close()
