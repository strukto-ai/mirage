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
import errno
import logging
import secrets
import time
import uuid
from collections.abc import Awaitable, Callable

from mirage.execution.base import ExecutionStore
from mirage.execution.errors import WorkspaceHeldError
from mirage.execution.job.constants import (
    GENERATION_BITS,
    HANGUP_EXIT_CODE,
    IGNORED_SIGNALS,
    KILLED_EXIT_CODE,
    LIST_CHECK_SECONDS,
    LIST_MAX_RETRIES,
    PUBLISH_SECONDS,
    SAVED_STATUSES,
    STOP_WAIT_SECONDS,
)
from mirage.execution.job.handle import JobHandle, JobRunner, mark_killed
from mirage.execution.job.types import Job, JobState
from mirage.execution.process.config import ProcessPermissions
from mirage.execution.process.handle import ProcessHandle
from mirage.execution.process.table import ProcessTable
from mirage.execution.ram import RAMExecutionStore
from mirage.execution.types import JobId, LineId
from mirage.shell.console import JobConsole
from mirage.types import PathSpec
from mirage.utils.clock import Clock, SystemClock
from mirage.workspace.record.types import RecordFields, generation_of

logger = logging.getLogger(__name__)


def _entry(record: Job, owner: str) -> RecordFields:
    """A job's entry in its session's list: its record, but for its
    number, which keys the entry, and its session, which keys the list,
    and the daemon running it.

    Args:
        record (Job): the job's record.
        owner (str): the id of the daemon running it.
    """
    return {
        "command": record.command,
        "cwd": record.cwd,
        "started_at": record.started_at,
        "line": str(record.line) if record.line is not None else None,
        "group": record.group,
        "console": record.id.console,
        "owner": owner,
        "state": record.state.value,
        "ended_at": record.ended_at,
        "exit": record.exit,
        "signal": record.signal,
    }


def _take_entry(job: JobHandle, entry: RecordFields) -> None:
    """Take how another daemon's job ended from its list entry, should
    the entry record an ending.

    Args:
        job (JobHandle): the job.
        entry (RecordFields): its list entry.
    """
    if entry["state"] != JobState.EXITED.value:
        return
    job.state, job.ended_at = JobState.EXITED, entry["ended_at"]
    job.exit_code, job.signal = entry["exit"], entry["signal"]


def _held_consoles(fields: RecordFields | None) -> set[str]:
    """The consoles a session's list holds, listed or disowned.

    Args:
        fields (RecordFields | None): the list, or None.
    """
    if fields is None:
        return set()
    listed = {entry["console"] for entry in fields.get("jobs", {}).values()}
    return listed | set(fields.get("disowned", {}))


class JobTable:
    """The shell's job table: bash's per-shell job list, one list per session.

    This is job control, not a process table. A job is numbered ``%N``
    within the session that launched it, numbering restarts at 1 once
    that session's list empties (GNU bash), and ``jobs``, ``wait``,
    ``fg``, ``kill`` and ``disown`` only ever see the calling session's
    list, exactly as one bash never lists another bash's jobs. Runner
    PIDs are tracked separately: ``$!`` and ``jobs -l`` report the
    managed PID, while ``%N`` names a session-local job number. A killed
    job's ``job.process`` stays STOPPING until the runner actually
    finishes, and its console ends then, or once the runner had
    ``STOP_WAIT_SECONDS`` to stop and did not.

    The lists live in the workspace's execution store, so every daemon
    on a shared store sees a session's jobs with the same numbers. For
    now one daemon runs a workspace's lines and jobs at a time: the one
    holding the workspace's lease, which its table takes (``claim``)
    before it starts anything and keeps until the workspace closes. A
    daemon is named by an id it keeps across restarts, so a restarted one
    takes its workspaces back at once, and ends as hung up the jobs it
    ran before. Another daemon's table lists the jobs, reads and waits
    on their consoles, and kills one by ending its console, which the
    holder watches for; it starts none while the lease holds, and is
    told which daemon holds it (``WorkspaceHeldError``). ``sync`` brings
    a session's list up to date before a builtin reads it. A job whose
    daemon lost the lease with no ending was lost with it and is ended
    as hung up, as a bash's job is when its terminal goes.

    The table is still owned by the workspace rather than by a session,
    because the workspace owns the tasks: teardown must stop every job
    it runs in every session (``kill_all``), snapshot capture reads every
    finished one (``all_jobs``), and a disowned job keeps running after
    its shell forgot it. Those are the only cross-session views; every
    other method takes the session whose list it reads, and the empty
    session id is the list a caller with no session (a bare table in a
    test) shares.
    """

    def __init__(
        self,
        store: ExecutionStore | None = None,
        processes: ProcessTable | None = None,
        parent: "JobTable | None" = None,
        clock: Clock | None = None,
        daemon: str | None = None,
    ) -> None:
        """Create a table, optionally choosing where its lists live.

        Args:
            store (ExecutionStore | None): the job plane holding each
                session's list and each job's console; None keeps them
                in memory, private to this table.
            processes (ProcessTable | None): where the jobs run.
            parent (JobTable | None): the table of the shell a ``$( )``
                is part of, whose jobs ``jobs`` still lists there, as
                bash's does; its ``wait`` and ``kill`` reach none of them.
            clock (Clock | None): the workspace clock a job's
                ``created_at`` is read on; None is the system clock.
            daemon (str | None): the id of the daemon this table runs
                on, which its lease names; None is a fresh one, a daemon
                no other table shares.
        """
        self.parent = parent
        self.clock: Clock = clock if clock is not None else SystemClock()
        self.processes = processes or ProcessTable()
        self.store: ExecutionStore = (
            store if store is not None else RAMExecutionStore()
        )
        self.daemon = daemon if daemon is not None else uuid.uuid4().hex
        self._claimed = False
        self._closed = False
        # One claim at a time, so a second waits for the first's lease
        # and a close for any claim under way.
        self._claim_lock = asyncio.Lock()
        # When the lease was last taken or renewed, on the monotonic
        # clock: past its length the lease may be another daemon's.
        self._renewed = 0.0
        # Records of programs this daemon left before a restart that the
        # run_stopper could not reach, published with this life's so a later
        # claim or another daemon tries them again.
        self._left: dict[str, RecordFields] = {}
        self._jobs: dict[str, dict[int, JobHandle]] = {}
        self._statuses: dict[str, dict[int, dict[str, int]]] = {}
        self._marks: dict[str, tuple[int | None, int | None]] = {}
        # Jobs `disown` removed from the table while they still run, and
        # ones another job's number displaced. The shell no longer lists,
        # waits for or reports them, but the workspace still owns their
        # tasks, so teardown can stop them; each leaves once it finishes.
        self._disowned: list[JobHandle] = []
        self._lease: asyncio.Task[None] | None = None
        self._checking: asyncio.Task[None] | None = None
        self._publishing: asyncio.Task[None] | None = None
        self._stopping_runs: set[asyncio.Task[None]] = set()
        # Lapsed owners this table already set about stopping, so a listing
        # that finds one again does not stop its runs again; and whether
        # teardown ended the stopping, which its runtimes are closing for.
        self._stopped_owners: set[str] = set()
        self._stops_ended = False
        self._swept = False
        # The table whose store and owner the process plane is read and
        # written through: this one, or for a child shell's table the
        # workspace's, since a child shell keeps only its job list private.
        self._plane = self
        # The table that holds each running job, by its runner's PID, kept
        # on the plane: a child shell's jobs are in its own table, where a
        # stop another workspace asks for has to find them.
        self._job_tables: dict[int, JobTable] = {}
        # Stops the program a lapsed owner's process ran past the
        # workspace, given the process as it was published and the first
        # signal, and answers whether this workspace reached it; the
        # workspace sets it, since it holds the runtimes that reach it.
        self.run_stopper: (
            Callable[[RecordFields, int], Awaitable[bool]] | None
        ) = None
        # Told each job this table's jobs run as it ends; the workspace
        # sets it, to trace the job.
        self.ended: Callable[[Job], None] | None = None
        # Run once this table's daemon takes the workspace's lease; the
        # workspace sets it, to end the line and process records the
        # daemon before it left running.
        self.taken: Callable[[], Awaitable[None]] | None = None
        # The bounds on killed jobs' stops (``_end_killed``), each with
        # its job.
        self._stopping: dict[asyncio.Task[None], JobHandle] = {}

    def child(self, parent: "JobTable | None" = None) -> "JobTable":
        """A table for a child shell (``bash -c``, a script, ``( )``,
        ``$( )``): a job list of its own on the same processes, kept in
        memory, since a child shell's jobs end with it on this workspace
        and no other one lists them.

        It lists and stops other workspaces' processes through this
        table, on the workspace's store.

        Args:
            parent (JobTable | None): the table a ``$( )`` still lists
                in ``jobs``.
        """
        table = JobTable(None, self.processes, parent, self.clock, self.daemon)
        table._plane = self._plane
        return table

    @property
    def claimed(self) -> bool:
        """Whether this table's daemon holds the workspace's lease, as of
        its ``claim`` or the last renewal."""
        return self._plane._claimed

    async def claim(self) -> None:
        """Take the workspace's lease for this table's daemon before it
        starts a line or a job; once taken it is kept until ``close``, so
        every later call answers at once.

        Taking it reads the highest pid the store recorded, so this
        daemon numbers past every pid given out before, and the processes
        this daemon left before a restart, whose native runs are stopped
        meanwhile; one this table runs now is its own. The processes this
        table runs are published from then on. A lease lost or left
        unrenewed past its length is asked for again. A child shell's
        table claims through the workspace's; a closed table takes none.

        Raises:
            WorkspaceHeldError: another daemon holds the lease.
        """
        if self._plane is not self:
            await self._plane.claim()
            return
        async with self._claim_lock:
            if (self._claimed and not self._lapsed()) or self._closed:
                return
            holder = await self.store.lease(self.daemon)
            if holder is not None:
                raise WorkspaceHeldError(self.processes.workspace_id, holder)
            live = {
                str(h.record.pid): h.record.started_at
                for h in self.processes.live()
            }
            earlier = {
                pid: record
                for pid, record in (await self.store.processes())
                .get(self.daemon, {})
                .items()
                if pid not in live or live[pid] != record.get("started_at")
            }
            self.processes.continue_after(await self.store.highest_pid())
            self._claimed = True
            self._renewed = time.monotonic()
            self._keep_lease()
            if self.taken is not None:
                try:
                    await self.taken()
                except Exception as exc:
                    logger.debug("lost records not ended: %s", exc)
            if earlier and not self._stops_ended:
                task = asyncio.ensure_future(self._stop_earlier(earlier))
                self._stopping_runs.add(task)
                task.add_done_callback(self._stopping_runs.discard)
            self.processes_changed()

    def _lapsed(self) -> bool:
        """Whether the lease went unrenewed past its length, so another
        daemon may hold it now."""
        lease = self.store.lease_seconds
        return lease is not None and time.monotonic() - self._renewed > lease

    def _lost(self) -> None:
        """Let the lease go once another daemon may hold it: the next line
        or job asks for it again, and what this table runs ends as hung
        up, as the daemon that took it records it, so the two never both
        change the workspace."""
        self._claimed = False
        self._lease = None
        for handle in self.processes.live():
            handle.terminate(HANGUP_EXIT_CODE - 128)

    async def submit(
        self,
        command: str,
        run: JobRunner,
        cwd: str,
        session_id: str = "",
        parent: int | None = None,
        limit: int | None = None,
        simple: bool = False,
    ) -> JobHandle:
        """Register a job in its session's list and start it.

        Its process is started first, so a session at its process cap
        refuses the job before it takes a number, and the job's entry
        names the line and group its process runs in. The number is
        taken from the store next, so two workspaces starting a job on
        one session never share one. The runner waits until the job and
        console are ready; failed setup stops the process before it
        enters the supplied runner. Only fully initialized jobs join the
        table.

        Args:
            command (str): the command line being run.
            run (JobRunner): produces the job's output and its result.
            cwd (str): working directory the job was started from.
            session_id (str): session whose job list the job joins.
            parent (int | None): the pid of the runner that started the
                job.
            limit (int | None): the session's process cap
                (``processes.max``); None for no cap.
            simple (bool): the job is one simple command
                (``JobHandle.simple``), which its process runs as.

        Raises:
            BlockingIOError: the session is at its process cap.
            WorkspaceHeldError: another daemon holds the workspace's
                lease (``claim``).
        """
        await self.claim()
        name = f"job_{uuid.uuid4().hex}"
        created_at = self.clock.now()
        job: JobHandle | None = None
        ready = asyncio.Event()

        async def execute() -> int:
            await ready.wait()
            if job is None:
                return KILLED_EXIT_CODE
            if job.state != JobState.RUNNING:
                return job.exit_code
            watcher = asyncio.ensure_future(job.watch())
            try:
                return await job.settle(run)
            finally:
                watcher.cancel()
                await self._record_ending(job)
                self._disowned = [j for j in self._disowned if j is not job]
                self._drop_checking()

        process = self.processes.start(
            session_id=session_id,
            command=command,
            cwd=PathSpec.from_str_path(cwd),
            run=execute,
            parent=parent,
            limit=limit,
            ignores=IGNORED_SIGNALS,
            one_command=simple,
            program_ignores=IGNORED_SIGNALS,
            background=True,
        )
        line, group = process.record.line, process.record.group
        try:
            job_id = await self._allocate(
                session_id,
                _entry(
                    Job(
                        JobId(self.processes.workspace_id, name),
                        0,
                        session_id,
                        command,
                        cwd,
                        created_at,
                        line,
                        group,
                        process.record.pid,
                    ),
                    self.daemon,
                ),
            )
        except BaseException:
            # A cancel can land after the store took the entry but before
            # its answer did; the entry names a job no runner will start.
            process.terminate()
            ready.set()
            await self._remove(session_id, {name}, give_back=True)
            raise
        try:
            console = JobConsole(self.store.console(name))
            console.bind_process(str(process.record.id))
            job = JobHandle(
                id=job_id,
                command=command,
                cwd=cwd,
                session_id=session_id,
                console=console,
                simple=simple,
                created_at=created_at,
                owner=self.daemon,
                console_name=name,
                workspace_id=self.processes.workspace_id,
                line=line,
                group=group,
                now=self.clock.now,
                ended=self._plane.ended,
            )
        except Exception:
            process.terminate()
            ready.set()
            await self._remove(session_id, {name}, give_back=True)
            raise
        job.process = process
        self._jobs.setdefault(session_id, {})[job_id] = job
        self._job_added(session_id, job_id)
        ready.set()
        plane, pid = self._plane, process.record.pid
        plane._job_tables[pid] = self
        process.task.add_done_callback(
            lambda _: plane._job_tables.pop(pid, None)
        )
        self._keep_checking()
        return job

    async def load(self, job: JobHandle) -> None:
        """Insert a finished job restored from a snapshot into its session.

        Its output moves onto a console in the store, so every workspace
        on it reads the job the way it reads one that ran there. It keeps
        its number unless another workspace's job holds it, and then takes
        the next free one rather than hide that job.

        Args:
            job (JobHandle): the restored job.
        """
        name = f"job_{uuid.uuid4().hex}"
        console = self.store.console(name)
        chunks, _, _ = await job.console.read_from(0)
        for chunk in chunks:
            await console.append(chunk.channel, chunk.data)
        restored = JobConsole(console, finished=True)
        if job.process_id is not None:
            restored.bind_process(job.process_id)
        job.console = restored
        job.owner = self.daemon
        job.console_name = name
        job.workspace_id = self.processes.workspace_id
        job.id = await self._insert(
            job.session_id, job.id, _entry(job.record, job.owner)
        )
        self._jobs.setdefault(job.session_id, {})[job.id] = job
        self._job_added(job.session_id, job.id)

    async def sync(self, session_id: str = "") -> None:
        """Bring a session's list up to date with the store.

        Adds the jobs other workspaces started, drops the ones they
        reaped or disowned (a job this table runs keeps running, on the
        side list ``disown`` uses), and settles a job whose console
        another workspace ended, or another workspace's job whose owner's
        lease lapsed with no ending. A job is the one listed under its
        number only while their consoles match: once the list empties,
        numbering restarts and a new job can take a reaped one's number.

        A console attached to a job first seen here is the job's only
        while the list has not changed since it was read: a store drops
        the console of a job reaped meanwhile, and attaching then would
        open an empty one that never ends. So the list is read again
        after such an attach, and the sync retried should it have moved.
        This table's own jobs are matched after the last read, with no
        wait between, so one it started meanwhile is never taken for
        another workspace's; a running one the list no longer names stays
        listed, unless the list holds it as disowned or another job took
        its number, and then it runs on unlisted, as a disowned job does.

        Args:
            session_id (str): the session whose list to refresh.
        """
        fields: RecordFields | None = None
        remotes: dict[str, JobHandle] = {}
        for _ in range(LIST_MAX_RETRIES):
            fields = await self.store.load(session_id)
            listed = fields.get("jobs", {}) if fields else {}
            known = {
                j.console_name for j in self._jobs.get(session_id, {}).values()
            }
            remotes = {
                entry["console"]: self._remote(int(key), session_id, entry)
                for key, entry in listed.items()
                if entry["console"] not in known
            }
            if not remotes or generation_of(
                await self.store.load(session_id)
            ) == generation_of(fields):
                break
        entries: RecordFields = fields.get("jobs", {}) if fields else {}
        held: RecordFields = fields.get("disowned", {}) if fields else {}
        mine = {
            j.console_name: j for j in self._jobs.get(session_id, {}).values()
        }
        jobs: dict[int, JobHandle] = {}
        for key, entry in entries.items():
            job = mine.pop(entry["console"], None)
            if job is None:
                job = remotes.get(entry["console"])
            if job is None:
                continue
            if job.process is None and job.state == JobState.RUNNING:
                _take_entry(job, entry)
            jobs[int(key)] = job
        for job in mine.values():
            if job.process is None or job.state != JobState.RUNNING:
                continue
            if job.console_name in held or job.id in jobs:
                self._disowned.append(job)
            else:
                jobs[job.id] = job
        self._jobs[session_id] = dict(sorted(jobs.items()))
        for job in jobs.values():
            if job.process is not None:
                await job.adopt_ending()
            elif job.state == JobState.RUNNING:
                await self._refresh(job)

    def get(self, job_id: int, session_id: str = "") -> JobHandle | None:
        return self._jobs.get(session_id, {}).get(job_id)

    def list_jobs(self, session_id: str = "") -> list[JobHandle]:
        return list(self._jobs.get(session_id, {}).values())

    def listing(self, session_id: str = "") -> list[JobHandle]:
        """The jobs ``jobs`` shows: a ``$( )``'s caller's, then its own.

        Args:
            session_id (str): the session whose jobs to list.
        """
        inherited = (
            self.parent.listing(session_id) if self.parent is not None else []
        )
        return inherited + self.list_jobs(session_id)

    def running_jobs(self, session_id: str = "") -> list[JobHandle]:
        return [
            j
            for j in self.list_jobs(session_id)
            if j.state == JobState.RUNNING
        ]

    def all_jobs(self) -> list[JobHandle]:
        """Every session's jobs, for the workspace-wide entry points only.

        Snapshot capture and the server summary read this; a shell
        builtin never does, since bash lists only its own jobs.
        """
        return [j for jobs in self._jobs.values() for j in jobs.values()]

    def all_running_jobs(self) -> list[JobHandle]:
        return [j for j in self.all_jobs() if j.state == JobState.RUNNING]

    async def kill(
        self, job_id: int, session_id: str = "", signal: int = 9
    ) -> bool:
        """Stop a job and record it as killed.

        The cancel is routed through the task's own loop, never awaited
        directly, because a caller may be on a different thread and loop
        than the job (an agent adapter reaching in through the sync
        bridge, a server request handler); awaiting a foreign task would
        raise.

        The job answers as killed at once, but its console ends only
        once the runner has stopped, so a program that handled the
        signal leaves its own status in the ending every workspace
        reads. Nothing here joins the runner. Cancellation is only
        observed where someone checks it, which today is the executor
        between nodes and the commands that take it, so a job sitting
        inside one long command would not notice until it finished on
        its own; joining would hang the shell on exactly the runaway job
        the caller is trying to stop. A runner that has not stopped
        ``STOP_WAIT_SECONDS`` later has its console ended for it, with
        the status the kill recorded, and one that has not begun has it
        ended at once: no program ran that could leave its own.

        Another daemon's job is killed by ending its console; that
        daemon sees the ending and stops the runner. Should the job have
        ended first, the ending it wrote stands and the job was not
        killed. INT and QUIT reach a running job and do nothing, as bash
        starts each job ignoring them.

        Args:
            job_id (int): the job to stop.
            session_id (str): the session whose list names it.
            signal (int): the signal the job is stopped with; its status
                is 128 plus it, KILL's 137 by default.
        """
        job = self.get(job_id, session_id)
        if job is None or job.state != JobState.RUNNING:
            return False
        if signal in IGNORED_SIGNALS:
            return True
        if job.process is not None:
            await self._stop_runner(job, job.process, signal)
            return True
        if not await self._running(job.owner):
            await self._stop_owner(job.owner)
        await mark_killed(job.console, 128 + signal, signal)
        await self._refresh(job)
        return job.signal is not None

    async def disown(self, job_id: int, session_id: str = "") -> bool:
        """Drop a job from its session's list without stopping it.

        What `disown` does in bash: the job keeps running, `jobs` no
        longer lists it and `wait` no longer knows it. The job stays on a
        side list so `kill_all` at teardown still reaches its task.

        Args:
            job_id (int): the job to drop.
            session_id (str): the session whose list names it.
        """
        self._jobs_leaving(session_id, {job_id})
        job = self._jobs.get(session_id, {}).pop(job_id, None)
        if job is None:
            return False
        running = job.state == JobState.RUNNING
        if job.process is not None and running:
            self._disowned.append(job)
        self._keep_statuses(session_id, [job], running_status=0)
        await self._remove(session_id, {job.console_name}, disowned=running)
        return True

    async def close_session(self, session_id: str) -> list[JobHandle]:
        """Drop a session's job list when the session closes, stopping
        what is still running, and return what was stopped.

        What happens to a bash's jobs when that bash exits: they are
        hung up, and a later shell that reuses the same id starts from
        an empty list numbered from 1 rather than inheriting jobs it
        never launched, under a profile it may not share. Session closure
        revokes its process entry points and stops disowned runners too.
        Closing a session closes it everywhere, so the jobs other
        workspaces run in it are stopped too, the disowned ones included:
        their consoles are ended, which their owners watch for. The list
        goes only while it is the one the stops were taken from: a job
        another workspace starts meanwhile changes it, and the close
        stops that job too before it tries again.

        Args:
            session_id (str): the session being closed.
        """
        stopped: dict[str, JobHandle] = {}
        for _ in range(LIST_MAX_RETRIES):
            fields = await self.store.load(session_id)
            await self.sync(session_id)
            for job in self.running_jobs(session_id):
                await self.kill(job.id, session_id)
                stopped[job.console_name] = job
            for name, entry in (fields or {}).get("disowned", {}).items():
                if entry["owner"] != self.daemon:
                    console = JobConsole(self.store.console(name))
                    await mark_killed(
                        console, KILLED_EXIT_CODE, KILLED_EXIT_CODE - 128
                    )
            if await self.store.delete(session_id, generation_of(fields)):
                self._jobs.pop(session_id, None)
                self._marks.pop(session_id, None)
                self._statuses.pop(session_id, None)
                self.processes.revoke_session(session_id)
                return list(stopped.values())
        raise RuntimeError(
            f"job list of session {session_id!r} kept conflicting "
            "with another writer"
        )

    async def kill_all(self) -> list[JobHandle]:
        """Stop every running job this table runs in every session,
        returning the ones that were running.

        Disowned jobs are stopped too: the shell forgot them, the
        workspace did not, and a teardown that left them running would
        leak their tasks. Another workspace's jobs are its own to stop.
        The stopping of lapsed owners' runs ends here as well, before the
        runtimes it reaches them through close.
        """
        self._stops_ended = True
        runs = list(self._stopping_runs)
        for task in runs:
            task.cancel()
        await asyncio.gather(*runs, return_exceptions=True)
        running = [j for j in self.all_running_jobs() if j.process is not None]
        for job in [*running, *self._disowned]:
            if job.state == JobState.RUNNING and job.process is not None:
                await job.stop()
        self._disowned = []
        return running

    async def close(self) -> None:
        """Give the workspace's lease up, at workspace teardown, so
        another daemon may run it.

        Called after ``kill_all``, so every job this table ran has
        ended and other daemons need no lease to settle them; a killed
        job whose runner is still stopping has its console ended now
        rather than at its bound. What is left of this daemon's record is
        the programs it could not reach, for the next to try. The store
        itself belongs to the workspace's state store.
        """
        self._closed = True
        async with self._claim_lock:
            for task in (self._lease, self._checking, self._publishing):
                if task is not None:
                    task.cancel()
            self._lease = self._checking = self._publishing = None
            for task in list(self._stopping_runs):
                task.cancel()
            if self._claimed:
                self._claimed = False
                try:
                    await self.store.publish(
                        self.daemon, dict(self._left), self.processes.last_pid
                    )
                    await self.store.release(self.daemon)
                except Exception as exc:
                    logger.debug("workspace lease not released: %s", exc)
        stopping = dict(self._stopping)
        for task in stopping:
            task.cancel()
        if stopping:
            done, _ = await asyncio.wait(stopping)
            for task in done:
                if not task.cancelled() and task.exception() is not None:
                    logger.debug(
                        "ending a killed job failed: %s", task.exception()
                    )
        for job in stopping.values():
            await self._end_stopping(job)

    async def wait(self, job_id: int, session_id: str = "") -> JobHandle:
        """Block until a job ends, then return it.

        Joined on the console's ending chunk, never on the status field:
        ``kill`` and ``_settle`` both flip the status before their final
        appends, so a status-based return could let the caller snapshot
        and reap the job before ``Killed`` or the ending chunk is
        persisted (a waiter on another loop today, any store that
        suspends tomorrow). A restored job has no task and its console
        already holds the ending chunk, so it returns without waiting.

        A killed job's console ends once its runner has stopped, or
        ``STOP_WAIT_SECONDS`` after the kill: what it started stops in
        that time (a handler finishes, a machine's run is stopped) and the
        status it leaves is the one answered, as bash's ``wait`` answers
        once the child has gone. An ending another workspace wrote is
        taken at once, before this table's watcher stops the runner. The
        runner is joined too, for at most ``STOP_WAIT_SECONDS``, so what
        its task holds is let go before this returns.

        Another daemon's job answers the status its ending records.
        While none is stored the lease is checked every third of its
        length, and one that daemon lost ends the job as hung up.

        Args:
            job_id (int): the job to wait for.
            session_id (str): the session whose list names it.
        """
        job = self._jobs[session_id][job_id]
        if job.process is None:
            if job.state == JobState.RUNNING:
                await self._join_remote(job)
            return job
        await job.console.wait_finished()
        await job.adopt_ending()
        try:
            async with asyncio.timeout(STOP_WAIT_SECONDS):
                await job.process.join()
        except TimeoutError:
            logger.debug("job %d still stopping after wait", job.id)
        return job

    async def wait_all(self, session_id: str = "") -> list[JobHandle]:
        """Join every job in a session's list, returning the ones still
        running.

        Every job, not only the running ones: a killed job's ``Killed``
        marker can still be in flight (see ``wait``), and bare ``wait``
        snapshots each console right after this returns. Joining a
        finished job costs one read.

        Args:
            session_id (str): the session whose list is joined.
        """
        running = self.running_jobs(session_id)
        for job in self.list_jobs(session_id):
            await self.wait(job.id, session_id)
        return running

    async def reap(self, job_id: int, session_id: str = "") -> None:
        """Remove one job from its session's list.

        What a targeted ``wait``/``fg`` does once the job has ended,
        matching GNU bash, where a job waited on by id is deleted from
        the job list, so a later ``jobs`` or ``wait %N`` no longer finds
        it.

        Args:
            job_id (int): the job to remove.
            session_id (str): the session whose list names it.
        """
        self._jobs_leaving(session_id, {job_id})
        job = self._jobs.get(session_id, {}).pop(job_id, None)
        if job is not None:
            self._keep_statuses(session_id, [job])
            await self._remove(session_id, {job.console_name})

    def _keep_statuses(
        self,
        session_id: str,
        jobs: list[JobHandle],
        running_status: int | None = None,
    ) -> None:
        """Keep how ended jobs ended under the pids that name them, which
        a later ``wait`` answers from once the job has left the list.

        Args:
            session_id (str): the session whose jobs they are.
            jobs (list[JobHandle]): the jobs leaving its list.
            running_status (int | None): what a job still running answers
                once it has left, as a disowned one does; None keeps
                nothing for it.
        """
        kept = self._statuses.setdefault(session_id, {})
        for job in jobs:
            code = (
                running_status
                if job.state == JobState.RUNNING
                else job.exit_code
            )
            if code is not None:
                for pid, machine in job.named_pids:
                    kept.setdefault(pid, {})[machine] = code
        for pid in list(kept)[: max(0, len(kept) - SAVED_STATUSES)]:
            del kept[pid]

    def forget_statuses(self, session_id: str = "") -> None:
        """Drop how the jobs that left the list ended, as a bare ``wait``
        does, which leaves bash nothing to answer for their pids.

        Args:
            session_id (str): the session whose jobs they were.
        """
        self._statuses.pop(session_id, None)

    def saved_statuses(self, session_id: str, pid: int) -> dict[str, int]:
        """How the jobs a pid named ended, once they have left the list.

        Args:
            session_id (str): the session whose jobs they were.
            pid (int): the pid.

        Returns:
            dict[str, int]: each machine's status for it, as ``ps`` shows
            the machine; empty for a pid no ended job had.
        """
        return self._statuses.get(session_id, {}).get(pid, {})

    def job_marks(self, session_id: str = "") -> tuple[int | None, int | None]:
        """The jobs ``jobs`` marks ``+`` and ``-``: the newest two, until
        one of those leaves the list, when the marks go to the newest
        running ones, and a job started after that takes ``+``.

        Args:
            session_id (str): the session whose list it is.
        """
        kept = self._marks.get(session_id)
        if kept is not None:
            return kept
        if self.parent is not None and not self._jobs.get(session_id):
            return self.parent.job_marks(session_id)
        newest = sorted(self._jobs.get(session_id, {}), reverse=True)
        return (
            newest[0] if newest else None,
            newest[1] if len(newest) > 1 else None,
        )

    def _job_added(self, session_id: str, job_id: int) -> None:
        kept = self._marks.get(session_id)
        if kept is not None:
            self._marks[session_id] = (job_id, kept[0])

    def _jobs_leaving(self, session_id: str, ids: set[int]) -> None:
        if not ids.intersection(self.job_marks(session_id)):
            return
        running = sorted(
            (
                job.id
                for job in self._jobs.get(session_id, {}).values()
                if job.state == JobState.RUNNING and job.id not in ids
            ),
            reverse=True,
        )
        self._marks[session_id] = (
            running[0] if running else None,
            running[1] if len(running) > 1 else None,
        )

    async def pop_completed(
        self,
        session_id: str = "",
        keep: int | None = None,
        only: set[int] | None = None,
    ) -> list[JobHandle]:
        """Return a session's completed/killed jobs and remove them from
        its list.

        A reader holding a job's console keeps reading it: the console
        outlives its table entry and dies with its last reader.

        Args:
            session_id (str): the session whose list is pruned.
            keep (int | None): a job that stays listed all the same.
            only (set[int] | None): the jobs that may go, as ``jobs``
                forgets only what it printed; None for any.
        """
        jobs = self._jobs.get(session_id, {})
        completed = [
            j
            for j in jobs.values()
            if j.state != JobState.RUNNING
            and j.id != keep
            and (only is None or j.id in only)
        ]
        self._jobs_leaving(session_id, {j.id for j in completed})
        for j in completed:
            del jobs[j.id]
        self._keep_statuses(session_id, completed)
        if completed:
            await self._remove(session_id, {j.console_name for j in completed})
        return completed

    def processes_changed(self) -> None:
        """Publish the processes this table's workspace runs, now that
        one started: the publishing goes on while any runs
        (``_publish``). Only the daemon holding the lease publishes, from
        its ``claim`` on."""
        if not self._claimed or (
            self._publishing is not None and not self._publishing.done()
        ):
            return
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        self._publishing = asyncio.ensure_future(self._publish())

    async def remote_processes(self) -> dict[str, dict[str, RecordFields]]:
        """The processes other daemons on the store run in this
        workspace, daemon to PID to process, as each last published them.

        A daemon that lost the lease is left out: whatever it ran was
        lost with it, and the native runs it left are stopped meanwhile.
        """
        if self._plane is not self:
            return await self._plane.remote_processes()
        found: dict[str, dict[str, RecordFields]] = {}
        for daemon, records in (await self.store.processes()).items():
            if daemon == self.daemon or not records:
                continue
            if await self._running(daemon):
                found[daemon] = records
            else:
                self._stop_later(daemon)
        return found

    async def signal_remote(
        self,
        pid: int,
        signal: int,
        session_id: str,
        permissions: Callable[[], ProcessPermissions | None],
    ) -> bool:
        """Signal a process another daemon runs in this workspace, by
        its pid: that daemon stops it once it takes the stop, within
        ``PUBLISH_SECONDS``.

        Signal 0 only probes. The process of a daemon that lost the lease
        is gone, and the native runs it left are stopped instead. The
        grants are read once the store has answered, just before anything
        is stopped, so a profile replaced meanwhile stops nothing under
        the old one.

        Args:
            pid (int): the process.
            signal (int): the signal, 0 to probe.
            session_id (str): the calling session.
            permissions (Callable[[], ProcessPermissions | None]): whose
                processes it may see and stop, None once the caller's
                view is revoked.

        Returns:
            bool: whether one live process was signalled.

        Raises:
            PermissionError: the process is one the session sees but
                may not stop.
        """
        if self._plane is not self:
            return await self._plane.signal_remote(
                pid, signal, session_id, permissions
            )
        records = await self.store.processes()
        daemons = [
            found
            for found, processes in records.items()
            if found != self.daemon and str(pid) in processes
        ]
        if len(daemons) > 1:
            daemons = [
                found for found in daemons if await self._running(found)
            ]
        if len(daemons) != 1:
            return False
        record = records[daemons[0]][str(pid)]
        own = record.get("session") == session_id
        lapsed = not await self._running(daemons[0])
        granted = permissions()
        if granted is None or (granted.list == "session" and not own):
            return False
        if lapsed:
            await self._stop_owner(daemons[0])
            return False
        if granted.kill == "session" and not own:
            raise PermissionError(errno.EPERM, "Operation not permitted")
        if signal != 0:
            await self.store.request_stop(daemons[0], pid, signal)
        return True

    def _remote(
        self, job_id: int, session_id: str, entry: RecordFields
    ) -> JobHandle:
        """Another workspace's job, as its list entry describes it.

        Args:
            job_id (int): the job's number.
            session_id (str): the session whose list names it.
            entry (RecordFields): the job's list entry.
        """
        job = JobHandle(
            id=job_id,
            command=entry["command"],
            cwd=entry["cwd"],
            created_at=entry["started_at"],
            console=JobConsole(self.store.console(entry["console"])),
            session_id=session_id,
            owner=entry["owner"],
            console_name=entry["console"],
            workspace_id=self.processes.workspace_id,
            line=LineId(entry["line"]) if entry.get("line") else None,
            group=entry.get("group"),
            now=self.clock.now,
        )
        _take_entry(job, entry)
        return job

    async def _stop_runner(
        self, job: JobHandle, process: ProcessHandle, signal: int
    ) -> None:
        """Stop a job this table runs and record it as killed by ``signal``.

        One that has not begun has its console ended at once: no program
        ran that could leave its own status. One that has has its console
        ended once its runner stops, or ``STOP_WAIT_SECONDS`` later.

        Args:
            job (JobHandle): the running job.
            process (ProcessHandle): its runner.
            signal (int): the signal it is stopped with.
        """
        if not process.begun:
            await job.stop(signal)
            await self._record_ending(job)
            self._drop_checking()
            return
        job.kill(signal)
        task = asyncio.ensure_future(self._end_killed(job, process))
        self._stopping[task] = job
        task.add_done_callback(self._stopping.pop)

    async def _end_killed(
        self, job: JobHandle, process: ProcessHandle
    ) -> None:
        """End a killed job's console once its runner has stopped, or
        ``STOP_WAIT_SECONDS`` after the kill, whichever comes first.

        A runner that settles ends the console itself, with the status
        it left; this ends it with the status the kill recorded when the
        runner never got that far (cancelled before it began) or is
        still stopping.

        Args:
            job (JobHandle): the killed job.
            process (ProcessHandle): its runner.
        """
        try:
            async with asyncio.timeout(STOP_WAIT_SECONDS):
                await process.join()
        except TimeoutError:
            logger.debug("job %d still stopping after its kill", job.id)
        await self._end_stopping(job)

    async def _end_stopping(self, job: JobHandle) -> None:
        """End a killed job's console with the status its kill recorded,
        unless its runner already ended it.

        Args:
            job (JobHandle): the killed job.
        """
        if job.console.finished:
            return
        await job.end(
            job.exit_code,
            job.signal if job.signal is not None else KILLED_EXIT_CODE - 128,
        )
        await self._record_ending(job)
        self._drop_checking()

    async def _record_ending(self, job: JobHandle) -> None:
        """Keep how a job this table ran ended in its list entry, or drop
        its disowned record, which nothing else would.

        The entry outlives the console's output, which a shared store
        expires, so a workspace that attaches after the output went
        still reads how the job ended instead of taking it as hung up.
        A failed write is logged: the console still holds the ending.

        Args:
            job (JobHandle): a job this table ran, now ended.
        """
        kept = _entry(job.record, job.owner)
        try:
            for _ in range(LIST_MAX_RETRIES):
                fields = await self.store.load(job.session_id)
                if fields is None:
                    return
                jobs = dict(fields.get("jobs", {}))
                held = dict(fields.get("disowned", {}))
                entry = jobs.get(str(job.id))
                if held.pop(job.console_name, None) is None:
                    if (
                        entry is None
                        or entry["console"] != job.console_name
                        or entry == kept
                    ):
                        return
                    jobs[str(job.id)] = kept
                following = int(fields.get("next", 1))
                if await self._write(
                    job.session_id, fields, jobs, following, held
                ):
                    return
            logger.debug("job %d ending kept conflicting", job.id)
        except Exception as exc:
            logger.debug("job %d ending not kept: %s", job.id, exc)

    async def _refresh(self, job: JobHandle) -> None:
        """Settle another daemon's job from its console's ending, or end
        it as hung up when that daemon lost the lease with none.

        Args:
            job (JobHandle): another daemon's running job.
        """
        outcome = await job.console.outcome()
        if outcome is None:
            if await self._running(job.owner):
                return
            self._stop_later(job.owner)
            await mark_killed(
                job.console, HANGUP_EXIT_CODE, HANGUP_EXIT_CODE - 128
            )
            outcome = await job.console.outcome()
            if outcome is None:
                return
        job.take(outcome)

    async def _join_remote(self, job: JobHandle) -> None:
        """Block until another workspace's job ends.

        Args:
            job (JobHandle): another workspace's running job.
        """
        lease = self.store.lease_seconds
        while job.state == JobState.RUNNING:
            if lease is None:
                await job.console.wait_finished()
            else:
                try:
                    async with asyncio.timeout(lease / 3):
                        await job.console.wait_finished()
                except TimeoutError:
                    logger.debug("job %d still running elsewhere", job.id)
            if job.console.store.closed:
                return
            await self._refresh(job)

    async def _allocate(self, session_id: str, entry: RecordFields) -> int:
        """Add a job to a session's list under the next number.

        Numbering restarts at 1 once the list is empty, as GNU bash
        restarts it; without that, reaping after a targeted `wait` would
        leave a later `wait %1` pointing at nothing.

        Args:
            session_id (str): the session.
            entry (RecordFields): the job's list entry.
        """
        for _ in range(LIST_MAX_RETRIES):
            fields = await self.store.load(session_id)
            jobs = dict(fields.get("jobs", {})) if fields else {}
            job_id = int(fields.get("next", 1)) if fields and jobs else 1
            jobs[str(job_id)] = entry
            if await self._write(session_id, fields, jobs, job_id + 1):
                return job_id
        raise RuntimeError(
            f"job list of session {session_id!r} kept conflicting "
            "with another writer"
        )

    async def _insert(
        self, session_id: str, job_id: int, entry: RecordFields
    ) -> int:
        """Add a job to a session's list under its own number, or under
        the next free one should another job hold it, and return the
        number it took.

        Args:
            session_id (str): the session.
            job_id (int): the job's number.
            entry (RecordFields): the job's list entry.
        """
        for _ in range(LIST_MAX_RETRIES):
            fields = await self.store.load(session_id)
            jobs = dict(fields.get("jobs", {})) if fields else {}
            following = int(fields.get("next", 1)) if fields else 1
            taken = job_id
            if str(taken) in jobs:
                taken = following
                while str(taken) in jobs:
                    taken += 1
            jobs[str(taken)] = entry
            if await self._write(
                session_id, fields, jobs, max(following, taken + 1)
            ):
                return taken
        raise RuntimeError(
            f"job list of session {session_id!r} kept conflicting "
            "with another writer"
        )

    async def _remove(
        self,
        session_id: str,
        names: set[str],
        give_back: bool = False,
        disowned: bool = False,
    ) -> None:
        """Drop jobs from a session's list.

        Jobs are named by their consoles, never by number: another
        workspace may have reaped one and a new job taken its number.

        Args:
            session_id (str): the session.
            names (set[str]): the consoles of the jobs to drop.
            give_back (bool): the jobs never started, so the last number
                handed out is free again, as no job took it.
            disowned (bool): the jobs still run, disowned: their entries
                move to the list's disowned ones, by console, where the
                session's close still reaches them.
        """
        for _ in range(LIST_MAX_RETRIES):
            fields = await self.store.load(session_id)
            if fields is None:
                return
            stored = fields.get("jobs", {})
            dropped = {
                int(k) for k, v in stored.items() if v["console"] in names
            }
            if not dropped:
                return
            jobs = {k: v for k, v in stored.items() if int(k) not in dropped}
            following = int(fields.get("next", 1))
            if give_back and following - 1 in dropped:
                following -= 1
            held = dict(fields.get("disowned", {}))
            if disowned:
                held |= {
                    v["console"]: v
                    for k, v in stored.items()
                    if int(k) in dropped
                    and v["state"] == JobState.RUNNING.value
                }
            if await self._write(session_id, fields, jobs, following, held):
                return
        raise RuntimeError(
            f"job list of session {session_id!r} kept conflicting "
            "with another writer"
        )

    async def _write(
        self,
        session_id: str,
        fields: RecordFields | None,
        jobs: RecordFields,
        following: int,
        disowned: RecordFields | None = None,
    ) -> bool:
        """Write a session's list over the one read, iff still current.

        A list written where none is starts at a random generation rather
        than at 1, so a list deleted and written again never repeats the
        generation a reader of the old one holds: a close that read the
        old one deletes the new one only once it has stopped its jobs.

        Args:
            session_id (str): the session.
            fields (RecordFields | None): the list as read.
            jobs (RecordFields): the jobs it holds now.
            following (int): the number the next job takes.
            disowned (RecordFields | None): the disowned jobs still
                running, by console; None keeps the ones read.
        """
        expected = generation_of(fields)
        held = (
            (fields or {}).get("disowned", {})
            if disowned is None
            else disowned
        )
        record: RecordFields = {
            "next": following,
            "jobs": jobs,
            "generation": (
                expected + 1
                if fields is not None
                else 1 + secrets.randbits(GENERATION_BITS)
            ),
        }
        if held:
            record["disowned"] = held
        return await self.store.cas_set(session_id, record, expected)

    def _keep_lease(self) -> None:
        """Renew the workspace's lease from ``claim`` until ``close``, on
        a store whose leases lapse."""
        lease = self.store.lease_seconds
        if lease is None or self._lease is not None or self._closed:
            return
        self._lease = asyncio.ensure_future(self._renew(lease / 3))

    async def _running(self, daemon: str) -> bool:
        """Whether a daemon still runs what it started here: it holds the
        workspace's lease and is not this table's own, whose jobs and
        processes from before a restart went with that life (the ones
        this table runs have their runners here).

        Args:
            daemon (str): the daemon's id.
        """
        return daemon != self.daemon and await self.store.holder() == daemon

    def _keep_checking(self) -> None:
        """Check the lists of the jobs this table runs every
        ``LIST_CHECK_SECONDS`` while it runs any."""
        if self._checking is None:
            self._checking = asyncio.ensure_future(self._check_lists())

    def _drop_checking(self) -> None:
        """Stop checking once every job this table runs has ended its
        console."""
        if self._checking is None or any(
            j.process is not None and not j.console.finished
            for j in [*self.all_jobs(), *self._disowned]
        ):
            return
        self._checking.cancel()
        self._checking = None

    async def _check_lists(self) -> None:
        """Stop each job this table runs that its session's list dropped.

        A close, a reap and a disown of a running job each end its
        console or keep its entry, so a list that dropped one whose
        console is still open went with its workspace, deleted
        elsewhere: an ending written there first would be deleted before
        this table's watch read it. The job is stopped as a closed
        session's is. Each session's list is read once a round, however
        many of its jobs run here; a round that failed for a session, on
        its list or on a console, is tried again the next round.
        """
        while True:
            await asyncio.sleep(LIST_CHECK_SECONDS)
            sessions: dict[str, list[JobHandle]] = {}
            for job in [*self.all_jobs(), *self._disowned]:
                if job.process is not None and job.state == JobState.RUNNING:
                    sessions.setdefault(job.session_id, []).append(job)
            for session_id, jobs in sessions.items():
                try:
                    held = _held_consoles(await self.store.load(session_id))
                    for job in jobs:
                        if job.console_name in held:
                            continue
                        await job.adopt_ending()
                        if (
                            job.state == JobState.RUNNING
                            and job.process is not None
                        ):
                            await self._stop_runner(job, job.process, 9)
                except Exception as exc:
                    logger.debug("job list check failed: %s", exc)

    def _records(self) -> dict[str, RecordFields]:
        """The live processes this workspace runs, as its record keeps
        them: a program's with where it runs and its pid there."""
        records: dict[str, RecordFields] = {}
        for handle in self.processes.live():
            record = handle.record
            records[str(record.pid)] = {
                "pid": record.pid,
                "parent": record.parent,
                "group": record.group,
                "session": record.session_id,
                "command": record.command,
                "cwd": record.cwd.virtual,
                "machine": str(record.machine),
                "started_at": record.started_at,
                "state": record.state.value,
                "line": str(record.line) if record.line is not None else None,
                "runtime": record.runtime,
                "machine_pid": (
                    {
                        "pid": record.machine_pid.pid,
                        "started": record.machine_pid.started,
                        "exited": record.machine_pid.exited,
                    }
                    if record.machine_pid is not None
                    else None
                ),
            }
        for pid, left in self._left.items():
            records.setdefault(pid, left)
        return records

    async def _publish(self) -> None:
        """Publish the processes this workspace runs every
        ``PUBLISH_SECONDS`` while it runs any, with the highest pid it
        handed out, and stop those other daemons asked it to stop. Once
        it runs none, its record goes and the publishing stops.

        The lease that vouches for the record is kept by ``_keep_lease``
        from the table's ``claim`` on, on its own timer whatever a round
        costs. The record is written again every third of the lease, so
        it outlives its store's expiry. Each record carries ``seen_at``,
        when its processes were read, the last time this daemon vouched
        for them and their native runs, on the host's clock, which a host
        stop compares with ``ps``. A failed round is logged and tried
        again the next one, and a stop that fails leaves the others it
        came with to be applied.
        """
        published: dict[str, RecordFields] | None = None
        lease = self.store.lease_seconds
        rewrite = (
            max(1, int(lease / 3 / PUBLISH_SECONDS))
            if lease is not None
            else 0
        )
        rounds = 0
        while True:
            seen = time.time()
            records = self._records()
            try:
                if records != published or (rewrite and rounds % rewrite == 0):
                    await self.store.publish(
                        self.daemon,
                        {
                            pid: {"seen_at": seen, **record}
                            for pid, record in records.items()
                        },
                        self.processes.last_pid,
                    )
                    published = records
                for pid, signal in await self.store.take_stops(self.daemon):
                    try:
                        await self._stop_asked(pid, signal)
                    except Exception as exc:
                        logger.debug("stop of %d not applied: %s", pid, exc)
            except Exception as exc:
                logger.debug("process publish failed: %s", exc)
            if published == {} and not self._records():
                return
            rounds += 1
            await asyncio.sleep(PUBLISH_SECONDS)

    async def _stop_asked(self, pid: int, signal: int) -> None:
        """Stop one of this workspace's processes another daemon asked
        to stop: a job's runner the way ``kill`` stops a job,
        through the table that holds it, a child shell's included; any
        other runner directly.

        Args:
            pid (int): the process.
            signal (int): the signal it is stopped with.
        """
        table = self._job_tables.get(pid, self)
        for job in table.all_jobs():
            if (
                job.process is not None
                and job.pid == pid
                and job.state == JobState.RUNNING
            ):
                await table.kill(job.id, job.session_id, signal)
                return
        for handle in self.processes.live():
            if handle.record.pid == pid:
                handle.terminate(signal)
                return

    def stop_lapsed(self) -> None:
        """Stop what the daemons that lost the lease left running,
        without waiting: the workspace calls it as it starts, so what a
        crashed daemon ran stops before anything lists it. Once per
        table, and only on a store whose leases lapse: on any other, no
        daemon loses one but by closing."""
        if (
            self._swept
            or self._stops_ended
            or self.store.lease_seconds is None
        ):
            return
        self._swept = True
        task = asyncio.ensure_future(self._sweep())
        self._stopping_runs.add(task)
        task.add_done_callback(self._stopping_runs.discard)

    async def _sweep(self) -> None:
        """Stop the programs of the daemons that lost the lease, and once more a lease
        later while another daemon still held it: one that died just
        before this one started still holds it until then."""
        try:
            live = await self.remote_processes()
            lease = self.store.lease_seconds
            if live and lease is not None:
                deadline = time.monotonic() + lease
                remaining = lease
                while remaining > 0:
                    await asyncio.sleep(remaining)
                    remaining = deadline - time.monotonic()
                await self.remote_processes()
        except Exception as exc:
            logger.debug("lapsed daemons not swept: %s", exc)

    def _stop_later(self, owner: str) -> None:
        """Stop the native runs a daemon that lost the lease left,
        without waiting.

        Args:
            owner (str): the daemon's id.
        """
        if self._stops_ended or owner in self._stopped_owners:
            return
        self._stopped_owners.add(owner)
        task = asyncio.ensure_future(self._stop_owner(owner))
        self._stopping_runs.add(task)
        task.add_done_callback(self._stopping_runs.discard)

    async def _stop_owner(self, owner: str) -> None:
        """Stop the programs a daemon that lost the lease left, those
        this workspace reaches, and keep its record holding only the
        rest, for a daemon that reaches them. This table's own daemon's
        record is its own life's, so it is never stopped here.

        Args:
            owner (str): the daemon's id.
        """
        if owner == self.daemon:
            return
        try:
            records = (await self.store.processes()).get(owner, {})
            kept = await self._stop_processes(owner, records)
            if not await self._running(owner):
                await self.store.publish(owner, kept)
        except Exception as exc:
            logger.debug("lapsed daemon %s not stopped: %s", owner, exc)

    async def _stop_earlier(self, records: dict[str, RecordFields]) -> None:
        """Stop the programs this daemon left before a restart, which
        ``claim`` found under its id. The ones the run_stopper could not reach
        stay in this life's record, as they were last vouched for.

        Args:
            records (dict[str, RecordFields]): PID to process, as the
                earlier life last published them.
        """
        try:
            self._left = await self._stop_processes(self.daemon, records)
        except Exception as exc:
            logger.debug("runs left before a restart not stopped: %s", exc)
            self._left = records
        if self._left:
            self.processes_changed()

    async def _stop_processes(
        self, owner: str, records: dict[str, RecordFields]
    ) -> dict[str, RecordFields]:
        """Hand each process a daemon's records list that ran a program
        past the workspace (its ``runtime``) to the run_stopper, and answer
        the ones this workspace could not reach. The lease is checked
        again before each is stopped, so a daemon that took it back
        meanwhile keeps its processes, and its records as they are.

        Args:
            owner (str): the daemon's id.
            records (dict[str, RecordFields]): PID to process.
        """
        left: dict[str, RecordFields] = {}
        for pid, record in records.items():
            if record.get("runtime") is None:
                continue
            if await self._running(owner):
                return records
            if self.run_stopper is None or not await self.run_stopper(
                record, 15
            ):
                left[pid] = record
        return left

    async def _renew(self, interval: float) -> None:
        """Renew the workspace's lease every ``interval`` seconds, with
        the consoles of the jobs this table still runs, so a quiet one
        keeps its output while this table lives.

        A failed renewal is logged and retried. Should another daemon
        take the lease, or the renewals fail past its length, the lease
        is let go (``_lost``): what this table runs ends as hung up, and
        the next line or job asks for it again (``claim``).

        Args:
            interval (float): seconds between renewals.
        """
        while True:
            await asyncio.sleep(interval)
            try:
                holder = await self.store.lease(
                    self.daemon,
                    [
                        j.console_name
                        for j in [*self.all_jobs(), *self._disowned]
                        if j.process is not None and not j.console.finished
                    ],
                )
            except Exception as exc:
                logger.debug("workspace lease renewal failed: %s", exc)
                if self._lapsed():
                    self._lost()
                    return
                continue
            if holder is not None:
                logger.debug("workspace lease taken by %s", holder)
                self._lost()
                return
            self._renewed = time.monotonic()
