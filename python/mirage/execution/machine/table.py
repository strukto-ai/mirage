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
import logging
import weakref
from collections import defaultdict
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from mirage.execution.machine.types import (
    Machine,
    MachineProcess,
    MachineState,
)
from mirage.execution.process.constants import MAX_PROCESSES
from mirage.execution.process.handle import ProcessHandle
from mirage.execution.process.table import ProcessTable
from mirage.execution.process.types import Process, ProcessState
from mirage.execution.types import MachineId, MachinePid, ProcessId
from mirage.machine.handle import MachineHandle
from mirage.machine.registry import build_machine
from mirage.shell.constants import CONTINUE_SIGNALS, STOP_SIGNALS
from mirage.workspace.record.types import RecordFields

logger = logging.getLogger(__name__)

# The table that holds each machine handle, so a second workspace cannot
# take, and close, a handle another one runs on; a table's close lets go.
_HOLDERS: weakref.WeakKeyDictionary[
    MachineHandle, "weakref.ref[MachineTable]"
] = weakref.WeakKeyDictionary()


class MachineTable:
    """The machines one workspace runs programs on, each one's handle
    under the name ``machines:`` gives it. The workspace's own host is
    not among them: what runs there needs no handle to reach it.

    It also keeps the processes scans found (``scan``): the ones a run
    started there besides its program, each a process of the
    workspace's table while scans still see it.

    Args:
        machines (Mapping[str, MachineHandle | Mapping[str, Any]] |
            None): each machine's handle or its YAML entry, by name.
        scan_host (Callable[[Mapping[int, tuple[str, float]]],
            Awaitable[list[MachineProcess]]] | None): scans the host
            programs' process groups, given each program's pid and tag;
            None leaves the host unscanned.
        signal_host (Callable[[MachinePid, int], Awaitable[bool]] |
            None): sends a signal to a host process; None sends none.
        stop_host (Callable[[MachinePid, float | None, int],
            Awaitable[bool]] | None): stops a host program a lapsed
            workspace left; None reaches none.

    Raises:
        ValueError: an entry no provider builds.
    """

    def __init__(
        self,
        machines: Mapping[str, MachineHandle | Mapping[str, Any]]
        | None = None,
        scan_host: Callable[
            [Mapping[int, tuple[str, float]]],
            Awaitable[list[MachineProcess]],
        ]
        | None = None,
        signal_host: Callable[[MachinePid, int], Awaitable[bool]]
        | None = None,
        stop_host: Callable[[MachinePid, float | None, int], Awaitable[bool]]
        | None = None,
    ) -> None:
        self._handles = {
            name: build_machine(name, spec)
            for name, spec in (machines or {}).items()
        }
        for name, handle in self._handles.items():
            held = _HOLDERS.get(handle)
            if held is not None and held() is not None:
                raise ValueError(
                    f"machine {name!r} is already in another workspace"
                )
        self._scan_host = scan_host
        self._signal_host = signal_host
        self._stop_host = stop_host
        # The processes scans found, by machine, pid and start, each
        # with the event that ends it once a scan no longer sees it and
        # the tag of the run that started it.
        self._found: dict[
            tuple[str, int, float], tuple[ProcessHandle, asyncio.Event, str]
        ] = {}
        # The runs whose program has ended that a scan has looked at
        # since, by tag; one not yet looked at is scanned once more for
        # what it left running.
        self._scanned_after_end: set[str] = set()
        # One scan at a time, so an older answer never lands after a
        # newer one and ends what the newer one found.
        self._scanning = asyncio.Lock()
        # One signal at a time on each machine, in the order they were
        # asked for, so a parent hears it before its children.
        self._signaling: defaultdict[str, asyncio.Lock] = defaultdict(
            asyncio.Lock
        )

    def hold_handles(self) -> None:
        """Hold every handle for this table's workspace, once it is
        built: a workspace that failed to build holds none, and another
        cannot take one until ``close``."""
        for handle in self._handles.values():
            _HOLDERS[handle] = weakref.ref(self)

    def names(self) -> list[str]:
        """Every machine's name, in the order ``machines:`` lists them."""
        return list(self._handles)

    def handles(self) -> list[MachineHandle]:
        """Every machine's handle, in the order ``machines:`` lists them."""
        return list(self._handles.values())

    def get(self, name: str) -> MachineHandle:
        """The handle of the machine ``name`` names.

        Args:
            name (str): the machine's name under ``machines:``.

        Raises:
            ValueError: the workspace has no such machine.
        """
        handle = self._handles.get(name)
        if handle is None:
            known = ", ".join(repr(n) for n in self._handles) or "none"
            raise ValueError(
                f"unknown machine: {name!r} (workspace machines: {known})"
            )
        return handle

    def by_id(self, machine: str) -> MachineHandle | None:
        """The handle whose id is ``machine``, written ``docker:tools``.

        Args:
            machine (str): a machine id as a process record names it.
        """
        return next(
            (h for h in self._handles.values() if str(h.id) == machine), None
        )

    async def check(
        self, now: Callable[[], float], machine: str | None = None
    ) -> list[Machine]:
        """Check every machine at once, or the one ``machine`` names,
        and answer what each check found.

        Args:
            now (Callable[[], float]): the workspace's clock, which
                stamps each record when its check ends.
            machine (str | None): only the machine with this id, written
                ``docker:tools``; None for every one.
        """
        handles = [
            h
            for h in self._handles.values()
            if machine is None or str(h.id) == machine
        ]
        return list(await asyncio.gather(*(_check(h, now) for h in handles)))

    async def scan(self, processes: ProcessTable, workspace: str) -> None:
        """Bring ``processes`` in step with what each machine runs now.

        A machine is scanned while a run executes there or a process an
        earlier scan found there still shows, and after a run there ends
        until a scan of it answers, the host likewise. A run's first
        process is the
        Mirage process the run is, when that process is the program (it
        has a runtime) and still runs, and its machine pid is recorded.
        Every other process the run started joins the table as a process
        of its own, with no runtime, under the process whose machine pid
        is its parent's, else under the run's while it runs, else at the
        top, and leaves it once a scan no longer sees it. A machine that
        does not answer keeps what it showed.

        Args:
            processes (ProcessTable): the workspace's processes.
            workspace (str): the workspace's id, which each run's tag
                starts with.
        """
        async with self._scanning:
            live = {
                str(handle.record.id): handle for handle in processes.live()
            }
            runs = {
                str(record.id): record
                for record in processes.records()
                if record.runtime is not None
            }
            ended = {tag for tag in runs if tag not in live}
            unscanned = ended - self._scanned_after_end
            still_scanned = self._scanned_after_end & ended
            found_tags = {tag for _, _, tag in self._found.values()}
            machines_to_scan = {machine for machine, _, _ in self._found}
            machines_to_scan |= {
                str(runs[tag].machine)
                for tag in unscanned
                if runs[tag].machine != processes.machine
            }
            scans: list[tuple[MachineId, Awaitable[list[MachineProcess]]]] = [
                (handle.id, handle.status(workspace))
                for handle in self._handles.values()
                if handle.executing or str(handle.id) in machines_to_scan
            ]
            if self._scan_host is not None:
                groups = {
                    record.machine_pid.pid: (tag, record.machine_pid.started)
                    for tag, record in runs.items()
                    if record.machine == processes.machine
                    and record.machine_pid is not None
                    and (tag in live or tag in unscanned or tag in found_tags)
                }
                if groups or str(processes.machine) in machines_to_scan:
                    scans.append((processes.machine, self._scan_host(groups)))
            found = await asyncio.gather(
                *(scan for _, scan in scans), return_exceptions=True
            )
            failed: set[str] = set()
            finishing: list[ProcessHandle] = []
            for (machine, _), rows in zip(scans, found, strict=True):
                if isinstance(rows, Exception):
                    logger.debug("%s: scan failed: %s", machine, rows)
                    failed.add(str(machine))
                    continue
                if isinstance(rows, BaseException):
                    raise rows
                finishing.extend(
                    self._apply_scan(processes, machine, rows, live, runs)
                )
            self._scanned_after_end = still_scanned | {
                tag
                for tag in unscanned
                if str(runs[tag].machine) not in failed
            }
            if finishing:
                await asyncio.wait([handle.task for handle in finishing])

    def send(
        self, processes: ProcessTable, handle: ProcessHandle, signum: int
    ) -> Awaitable[bool] | None:
        """Send a signal to a process that is a program on a machine, or
        one a scan found, as ``kill`` sent it: what it does with it is
        its own, and it ends when it exits.

        A program no scan has placed yet is the first process its run's
        tag marks. One its machine no longer shows (it has not started
        yet, or just exited) is stopped by Mirage instead, unless the
        signal is one a process takes and goes on (WINCH, CONT, a stop).

        Args:
            processes (ProcessTable): the workspace's processes.
            handle (ProcessHandle): the process.
            signum (int): the signal.

        Returns:
            Awaitable[bool] | None: whether it ran, once sent; None for
            a process Mirage stops itself.
        """
        record = handle.record
        if record.state != ProcessState.RUNNING:
            return None
        target = record.machine_pid
        if record.machine == processes.machine:
            if (
                self._signal_host is None
                or target is None
                or target.exited is not None
            ):
                return None
        elif self.by_id(str(record.machine)) is None or (
            target is None and record.runtime is None
        ):
            return None
        return self._deliver(
            handle, record.machine, target or str(record.id), signum
        )

    async def _deliver(
        self,
        handle: ProcessHandle,
        machine: MachineId,
        target: str | MachinePid,
        signum: int,
    ) -> bool:
        """Send ``signum`` as ``send`` does, once. A process a scan found
        stays when its machine does not answer, for the next scan to
        settle; only one the machine no longer shows leaves.

        Args:
            handle (ProcessHandle): the process.
            machine (MachineId): where it runs.
            target (str | MachinePid): its run's tag, or its machine pid.
            signum (int): the signal.
        """
        try:
            sent = await self._signal_on(machine, target, signum)
        except Exception as exc:
            logger.debug("%s: signal %d not sent: %s", machine, signum, exc)
            if handle.record.runtime is None:
                return False
            sent = False
        if sent:
            handle.program_signaled(signum)
            return True
        if handle.record.runtime is None:
            self._end_found(handle)
            return False
        if signum in CONTINUE_SIGNALS or signum in STOP_SIGNALS:
            return True
        return handle.terminate(
            signum, children=handle.record.parent is not None
        )

    async def stop(
        self, processes: ProcessTable, record: RecordFields, signum: int
    ) -> bool:
        """Stop the program a lapsed workspace's process ran past the
        workspace: a host program by its pid when it ran on this host, a
        machine's run through the machine it ran on, by its process's tag.

        Args:
            processes (ProcessTable): this workspace's table.
            record (RecordFields): the process, as its workspace published
                it.
            signum (int): the first signal.

        Returns:
            bool: True once this workspace reached the program and it was
            stopped; False leaves it to a workspace that reaches its own.
        """
        machine, pid = record.get("machine"), record.get("pid")
        found, seen = record.get("machine_pid"), record.get("seen_at")
        if not isinstance(pid, int):
            return False
        if machine == str(processes.machine) and isinstance(found, dict):
            if self._stop_host is None:
                return False
            return await self._stop_host(
                MachinePid(found["pid"], found["started"], found["exited"]),
                seen,
                signum,
            )
        handle = self.by_id(machine) if isinstance(machine, str) else None
        if handle is None:
            return False
        return await handle.stop(
            str(ProcessId(processes.workspace_id, pid)), signum
        )

    async def _signal_on(
        self, machine: MachineId, target: str | MachinePid, signum: int
    ) -> bool:
        """Send ``signum`` to one process on ``machine``.

        Args:
            machine (MachineId): where it runs.
            target (str | MachinePid): its run's tag, or its machine pid.
            signum (int): the signal.
        """
        async with self._signaling[str(machine)]:
            handle = self.by_id(str(machine))
            if handle is not None:
                return await handle.signal(target, signum)
            if self._signal_host is None or not isinstance(target, MachinePid):
                return False
            return await self._signal_host(target, signum)

    def _apply_scan(
        self,
        processes: ProcessTable,
        machine: MachineId,
        rows: list[MachineProcess],
        live: dict[str, ProcessHandle],
        runs: dict[str, Process],
    ) -> list[ProcessHandle]:
        """Bring the table in step with one machine's scan, answering
        the processes it no longer shows, now ending. A run of another
        machine entry is left out: two entries that reach one machine
        both see its processes, which are the other run's.

        Args:
            processes (ProcessTable): the workspace's processes.
            machine (MachineId): the machine scanned.
            rows (list[MachineProcess]): what the scan found.
            live (dict[str, ProcessHandle]): the live processes, by tag.
            runs (dict[str, Process]): the programs' processes the
                table keeps, ended ones included, by tag.
        """
        seen: set[tuple[str, int, float]] = set()
        tagged: dict[str, list[MachineProcess]] = {}
        for row in rows:
            tagged.setdefault(row.tag, []).append(row)
        for tag, run in tagged.items():
            handle = live.get(tag)
            owner = handle.record if handle is not None else runs.get(tag)
            if owner is not None and owner.machine != machine:
                continue
            pids = {row.pid for row in run}
            placed: dict[int, int] = {}
            if (
                handle is not None
                and handle.record.runtime is not None
                and handle.record.machine == machine
            ):
                root = _program_row(run, pids, handle.record.machine_pid)
                if root is not None:
                    handle.show_state(root.state)
                    placed[root.pid] = handle.record.pid
                    known = handle.record.machine_pid
                    if known is None or known.pid != root.pid:
                        handle.set_machine_pid(
                            MachinePid(root.pid, root.started)
                        )
            waiting = [row for row in run if row.pid not in placed]
            while waiting:
                left = {row.pid for row in waiting}
                ready = [row for row in waiting if row.ppid not in left]
                for row in ready or waiting:
                    parent = placed.get(row.ppid)
                    if parent is None and handle is not None:
                        parent = handle.record.pid
                    found = self._place_found(
                        processes, machine, row, parent, owner
                    )
                    if found is not None:
                        found.show_state(row.state)
                        placed[row.pid] = found.record.pid
                        seen.add((str(machine), row.pid, row.started))
                waiting = [
                    row for row in waiting if row not in (ready or waiting)
                ]
        finishing: list[ProcessHandle] = []
        for key in [k for k in self._found if k[0] == str(machine)]:
            if key not in seen:
                found, gone, _ = self._found.pop(key)
                gone.set()
                finishing.append(found)
        return finishing

    def _place_found(
        self,
        processes: ProcessTable,
        machine: MachineId,
        row: MachineProcess,
        parent: int | None,
        owner: Process | None,
    ) -> ProcessHandle | None:
        """The process a scan found ``row`` to be: the one an earlier
        scan placed, else a new one under ``parent`` (at the top for
        None), in its run's session.

        Args:
            processes (ProcessTable): the workspace's processes.
            machine (MachineId): where it runs.
            row (MachineProcess): what the scan found.
            parent (int | None): the pid of the process it is under.
            owner (Process | None): the process its run is, ended or
                not; None for a run the table no longer keeps. A run
                whose session was closed or re-profiled since places
                nothing.
        """
        key = (str(machine), row.pid, row.started)
        known = self._found.get(key)
        if known is not None and known[0].record.state == ProcessState.RUNNING:
            return known[0]
        if owner is None or not processes.current(owner):
            return None
        session = owner.session_id
        placed = sum(
            1
            for handle in processes.live()
            if handle.record.session_id == session
            and handle.record.runtime is None
            and handle.record.machine_pid is not None
        )
        if placed >= MAX_PROCESSES:
            logger.debug(
                "%s: process %d not placed: session %s holds %d found",
                machine,
                row.pid,
                session,
                placed,
            )
            return None
        gone = asyncio.Event()
        target = MachinePid(row.pid, row.started)
        held: list[ProcessHandle] = []

        async def run() -> int:
            try:
                await gone.wait()
            except asyncio.CancelledError:
                signum = held[0].signal if held else None
                await asyncio.shield(
                    self._stop_found(machine, target, signum or 15)
                )
                raise
            return 0

        try:
            handle = processes.start(
                session_id=owner.session_id,
                command=row.args,
                cwd=owner.cwd,
                run=run,
                parent=parent,
                line=owner.line,
                machine=machine,
            )
        except (RuntimeError, BlockingIOError) as exc:
            logger.debug(
                "%s: process %d not placed: %s", machine, row.pid, exc
            )
            return None
        held.append(handle)
        handle.set_machine_pid(target)
        self._found[key] = (handle, gone, row.tag)
        return handle

    async def _stop_found(
        self, machine: MachineId, target: MachinePid, signum: int
    ) -> None:
        """Stop a process a scan found, as Mirage stops what it runs.

        Args:
            machine (MachineId): where it runs.
            target (MachinePid): the process.
            signum (int): the signal Mirage stops it with.
        """
        try:
            await self._signal_on(machine, target, signum)
        except Exception as exc:
            logger.debug(
                "%s: process %d not stopped: %s", machine, target.pid, exc
            )

    def _end_found(self, handle: ProcessHandle) -> None:
        """End a process a scan found, which its machine no longer runs.

        Args:
            handle (ProcessHandle): the process.
        """
        for key, (found, gone, _) in list(self._found.items()):
            if found is handle:
                del self._found[key]
                gone.set()

    async def close(self) -> None:
        """Close every handle: unmount what each was served, and let go
        of it for another workspace."""
        for handle in self._handles.values():
            held = _HOLDERS.get(handle)
            if held is not None and held() is self:
                del _HOLDERS[handle]
        results = await asyncio.gather(
            *(handle.close() for handle in self._handles.values()),
            return_exceptions=True,
        )
        failures = [r for r in results if isinstance(r, BaseException)]
        if failures:
            raise (
                failures[0]
                if len(failures) == 1
                else BaseExceptionGroup("machine close failed", failures)
            )


def _program_row(
    run: list[MachineProcess], pids: set[int], known: MachinePid | None
) -> MachineProcess | None:
    """The program of a run: the process its report names, else the one
    carrying its tag whose parent carries none, the one already known
    while it still shows, else the first to start. A program that has
    gone is none of what it left running.

    Args:
        run (list[MachineProcess]): the run's processes.
        pids (set[int]): their pids.
        known (MachinePid | None): the program's machine pid, as known.
    """
    reported = run[0].program if run else None
    if reported is not None:
        return next((row for row in run if row.pid == reported), None)
    roots = [row for row in run if row.ppid not in pids]
    if known is not None:
        return next((row for row in roots if row.pid == known.pid), None)
    return min(roots, key=lambda row: row.started, default=None)


async def _check(handle: MachineHandle, now: Callable[[], float]) -> Machine:
    """One machine's record, as a check of it finds it now.

    Args:
        handle (MachineHandle): the machine.
        now (Callable[[], float]): the workspace's clock.
    """
    try:
        managed = await handle.check()
    except Exception as exc:
        logger.debug("%s: check failed: %s", handle.id, exc)
        state = MachineState.UNREACHABLE
    else:
        state = MachineState.MANAGED if managed else MachineState.REACHABLE
    return Machine(handle.id, state, now())
