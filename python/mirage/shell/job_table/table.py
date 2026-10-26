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
import uuid
from collections.abc import Awaitable, Callable

from mirage.process.config import ProcessPermissions
from mirage.process.handle import ProcessHandle
from mirage.process.table import ProcessTable
from mirage.shell.bytes import encode_text
from mirage.shell.console import (
    KILLED_OUTCOME,
    Channel,
    JobConsole,
    exit_outcome,
    killed_outcome,
)
from mirage.shell.job_table.constants import (
    GENERATION_BITS,
    HANGUP_EXIT_CODE,
    KILLED_EXIT_CODE,
    LIST_CHECK_SECONDS,
    LIST_MAX_RETRIES,
    PUBLISH_SECONDS,
    STOP_WAIT_SECONDS,
    WATCH_RETRY_SECONDS,
)
from mirage.shell.job_table.ram import RAMJobStore
from mirage.shell.job_table.store import JobStore
from mirage.shell.job_table.types import Job, JobRunner, JobStatus
from mirage.types import JsonValue, PathSpec
from mirage.utils.clock import Clock, SystemClock
from mirage.workspace.record.types import RecordFields, generation_of

logger = logging.getLogger(__name__)


def cancel_job(job: Job, signal: int = 9) -> None:
    """Ask a job to stop, from any thread, without waiting for it.

    Routed through the task's own loop because the caller is often
    somewhere else entirely: a sync teardown path, an agent adapter on a
    pool thread, a server request handler. Tolerates a loop that has
    already shut down, which is the normal case during interpreter exit.

    Args:
        job (Job): the job to cancel.
        signal (int): what the stop stands for, KILL (9) unless a
            ``kill`` named another.
    """
    try:
        if job.process is not None:
            job.process.terminate(signal)
    except RuntimeError as exc:
        # The loop that was running this job is gone, so the job is too.
        logger.debug("job %d loop is gone: %s", job.id, exc)


def _ended(outcome: str) -> tuple[JobStatus, int]:
    """The status and exit code a console's ending records.

    Args:
        outcome (str): the ending's text, ``exit:<code>`` or
            ``killed:<code>``.
    """
    form, _, code = outcome.partition(":")
    status = (
        JobStatus.KILLED if form == KILLED_OUTCOME else JobStatus.COMPLETED
    )
    return status, int(code)


def _outcome_of(job: Job) -> str:
    """The ending text an ended job's status and exit code record.

    Args:
        job (Job): an ended job.
    """
    if job.status == JobStatus.KILLED:
        return killed_outcome(job.exit_code)
    return exit_outcome(job.exit_code)


async def _mark_killed(console: JobConsole, exit_code: int) -> None:
    """Write the kill marker and the ending chunk.

    Args:
        console (JobConsole): the killed job's console.
        exit_code (int): the status the job answers.
    """
    await console.emit(Channel.STDERR, b"Killed")
    await console.finish(killed_outcome(exit_code))


async def _record(job: Job, status: JobStatus, exit_code: int) -> None:
    """End a job's console with how it ended, then take the ending the
    console holds.

    Another workspace's ``kill``, or the bound on a killed job's stop,
    may have ended the console first; the store keeps the first ending,
    and every workspace answers that one. Status is set before the
    console is finished, so a reader released by the ending chunk always
    sees settled fields.

    Args:
        job (Job): the job that ended.
        status (JobStatus): how it ended.
        exit_code (int): the status it answers.
    """
    job.status, job.exit_code = status, exit_code
    if status == JobStatus.KILLED:
        await _mark_killed(job.console, exit_code)
    else:
        await job.console.finish(exit_outcome(exit_code))
    if job.console.store.closed:
        return
    outcome = await job.console.outcome()
    if outcome is not None:
        job.status, job.exit_code = _ended(outcome)


async def _stop(job: Job, signal: int = 9) -> None:
    """Stop a running job and settle it as killed by ``signal``.

    Args:
        job (Job): the running job.
        signal (int): the signal it is stopped with; its status is 128
            plus it.
    """
    cancel_job(job, signal)
    job.status = JobStatus.KILLED
    job.exit_code = 128 + signal
    await _mark_killed(job.console, job.exit_code)


def _stopped_status(job: Job) -> int:
    """The status a stopped job answers: the one its program exited with
    after handling the signal, when the job is that one program, else
    128 plus the signal, KILL's 137 without one.

    Args:
        job (Job): the stopped job.
    """
    if job.process is None:
        return KILLED_EXIT_CODE
    code = job.process.program_code
    if job.simple and code is not None:
        return code
    signal = job.process.signal
    return KILLED_EXIT_CODE if signal is None else 128 + signal


async def _settle(run: JobRunner, job: Job) -> int:
    """Run a job to completion and record how it ended.

    A job's console ends here, in the job's own task, once its runner
    has: ``kill`` only stops the runner, so a program that handled the
    signal leaves its own status (``_stopped_status``) in the ending
    every workspace reads. A job something stopped ends as killed however
    its runner finished.

    Args:
        run (JobRunner): produces the job's output and its result.
        job (Job): the job being run.
    """
    try:
        io_result, _ = await run(job)
    except asyncio.CancelledError:
        # This task is already unwinding from a cancel, and a store that
        # suspends (Redis) would take a second cancellation mid-write
        # and lose the ending readers are parked on. The shielded task
        # keeps running to completion even if this one is cancelled
        # again; RAM completes without ever suspending either way.
        ending = asyncio.ensure_future(
            _record(job, JobStatus.KILLED, _stopped_status(job))
        )
        while not ending.done():
            try:
                await asyncio.shield(ending)
            except asyncio.CancelledError:
                logger.debug("job %d cancelled again while ending", job.id)
        ending.result()
        raise
    except Exception as exc:
        # Recorded as the job's output and exit status rather than
        # re-raised: nobody awaits this task, so re-raising would only
        # strand the error in an unretrieved future.
        logger.debug("background job %d failed: %s", job.id, exc)
        if job.status != JobStatus.RUNNING:
            await _record(job, JobStatus.KILLED, _stopped_status(job))
            return 1
        await job.console.emit(Channel.STDERR, encode_text(str(exc)))
        await _record(job, JobStatus.COMPLETED, 1)
        return 1
    if job.status != JobStatus.RUNNING:
        await _record(job, JobStatus.KILLED, _stopped_status(job))
    else:
        await _record(job, JobStatus.COMPLETED, io_result.exit_code)
    return io_result.exit_code


async def _adopt_ending(job: Job) -> None:
    """Stop a job this table runs if another workspace ended its console.

    A ``kill`` elsewhere ends the job's console, the one record of how
    the job ended, and this cancels the runner the way a local kill
    does, with the signal the ending implies.

    Args:
        job (Job): a job this table runs.
    """
    if job.status != JobStatus.RUNNING:
        return
    outcome = await job.console.outcome()
    if outcome is None or job.status != JobStatus.RUNNING:
        return
    job.status, job.exit_code = _ended(outcome)
    cancel_job(job, job.exit_code - 128 if job.exit_code > 128 else 9)


async def _watch(job: Job) -> None:
    """Stop a job this table runs once another workspace ends it.

    A failed read is retried until the runner settles, which cancels
    the watch: one that gave up would leave a kill from elsewhere
    unheeded while the job ran on.

    Args:
        job (Job): a job this table runs.
    """
    store = job.console.store
    while not store.closed:
        try:
            await store.wait_ended()
            await _adopt_ending(job)
            return
        except Exception as exc:
            logger.debug("job %d watch failed: %s", job.id, exc)
        await asyncio.sleep(WATCH_RETRY_SECONDS)


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

    The lists live in the workspace's job store, so every workspace on a
    shared store sees a session's jobs with the same numbers. A job runs
    on the table that started it, its owner; another table lists it,
    reads and waits on its console, and kills it by ending that console,
    which its owner watches for. ``sync`` brings a session's list up to
    date before a builtin reads it. A job whose owner's lease lapsed with
    no ending was lost with its owner and is ended as hung up, as a
    bash's job is when its terminal goes.

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
        store: JobStore | None = None,
        processes: ProcessTable | None = None,
        parent: "JobTable | None" = None,
        clock: Clock | None = None,
    ) -> None:
        """Create a table, optionally choosing where its lists live.

        Args:
            store (JobStore | None): the job plane holding each
                session's list and each job's console; None keeps them
                in memory, private to this table.
            processes (ProcessTable | None): where the jobs run.
            parent (JobTable | None): the table of the shell a ``$( )``
                is part of, whose jobs ``jobs`` still lists there, as
                bash's does; its ``wait`` and ``kill`` reach none of them.
            clock (Clock | None): the workspace clock a job's
                ``created_at`` is read on; None is the system clock.
        """
        self.parent = parent
        self.clock: Clock = clock if clock is not None else SystemClock()
        self.processes = processes or ProcessTable()
        self.store: JobStore = store if store is not None else RAMJobStore()
        self.owner = uuid.uuid4().hex
        self._jobs: dict[str, dict[int, Job]] = {}
        # Jobs `disown` removed from the table while they still run, and
        # ones another job's number displaced. The shell no longer lists,
        # waits for or reports them, but the workspace still owns their
        # tasks, so teardown can stop them; each leaves once it finishes.
        self._disowned: list[Job] = []
        self._lease: asyncio.Task[None] | None = None
        self._checking: asyncio.Task[None] | None = None
        self._publishing: asyncio.Task[None] | None = None
        self._reaping: set[asyncio.Task[None]] = set()
        # Lapsed owners this table already set about reaping, so a listing
        # that finds one again does not stop its runs again; and whether
        # teardown stopped the reaping, which its runtimes are closing for.
        self._reaped: set[str] = set()
        self._reaping_stopped = False
        # The table whose store and owner the process plane is read and
        # written through: this one, or for a child shell's table the
        # workspace's, since a child shell keeps only its job list private.
        self._plane = self
        # Stops the native runs a lapsed owner left, given them and the
        # first signal, and answers the ones this workspace cannot reach;
        # the workspace sets it, since it holds the runtimes that reach
        # them.
        self.reaper: (
            Callable[
                [list[dict[str, JsonValue]], int],
                Awaitable[list[dict[str, JsonValue]]],
            ]
            | None
        ) = None
        # The bounds on killed jobs' stops (``_end_killed``), each with
        # its job.
        self._stopping: dict[asyncio.Task[None], Job] = {}

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
        table = JobTable(None, self.processes, parent, self.clock)
        table._plane = self._plane
        return table

    async def submit(
        self,
        command: str,
        run: JobRunner,
        cwd: str,
        session_id: str = "",
        parent_pid: int | None = None,
        limit: int | None = None,
        simple: bool = False,
    ) -> Job:
        """Register a job in its session's list and start it.

        The job's number is taken from the store first, so two
        workspaces starting a job on one session never share one; a
        process slot is reserved next, and a refused one gives the
        number back. The runner is deferred until the job and console
        are ready; failed setup cancels the reservation without
        entering the supplied runner. Only fully initialized jobs join
        the table.

        Args:
            command (str): the command line being run.
            run (JobRunner): produces the job's output and its result.
            cwd (str): working directory the job was started from.
            session_id (str): session whose job list the job joins.
            parent_pid (int | None): the runner that started the job.
            limit (int | None): the session's process cap
                (``processes.max``); None for no cap.
            simple (bool): the job is one simple command (``Job.simple``).

        Raises:
            BlockingIOError: the session is at its process cap.
        """
        name = uuid.uuid4().hex
        created_at = self.clock.now()
        await self.store.renew(self.owner)
        try:
            job_id = await self._allocate(
                session_id,
                {
                    "command": command,
                    "cwd": cwd,
                    "created_at": created_at,
                    "owner": self.owner,
                    "console": name,
                },
            )
        except BaseException:
            # A cancel can land after the store took the entry but before
            # its answer did; the entry names a job no runner will start.
            await self._remove(session_id, {name}, give_back=True)
            raise
        job: Job | None = None

        async def execute() -> int:
            if job is None:
                return KILLED_EXIT_CODE
            if job.status != JobStatus.RUNNING:
                return job.exit_code
            watcher = asyncio.ensure_future(_watch(job))
            try:
                return await _settle(run, job)
            finally:
                watcher.cancel()
                await self._record_ending(job)
                self._disowned = [j for j in self._disowned if j is not job]
                self._drop_lease()
                self._drop_checking()

        try:
            process = self.processes.start(
                session_id=session_id,
                command=command,
                cwd=PathSpec.from_str_path(cwd),
                run=execute,
                parent_pid=parent_pid,
                limit=limit,
            )
        except BaseException:
            await self._remove(session_id, {name}, give_back=True)
            raise
        try:
            console = JobConsole(self.store.console(name))
            console.bind_execution(process.info.execution_id)
            job = Job(
                id=job_id,
                command=command,
                cwd=cwd,
                session_id=session_id,
                console=console,
                simple=simple,
                created_at=created_at,
                owner=self.owner,
                console_name=name,
            )
        except Exception:
            process.terminate()
            await self._remove(session_id, {name}, give_back=True)
            raise
        job.process = process
        self._jobs.setdefault(session_id, {})[job_id] = job
        self._keep_lease()
        self._keep_checking()
        return job

    async def load(self, job: Job) -> None:
        """Insert a finished job restored from a snapshot into its session.

        Its output moves onto a console in the store, so every workspace
        on it reads the job the way it reads one that ran there. It keeps
        its number unless another workspace's job holds it, and then takes
        the next free one rather than hide that job.

        Args:
            job (Job): the restored job.
        """
        name = uuid.uuid4().hex
        console = self.store.console(name)
        chunks, _, _ = await job.console.read_from(0)
        for chunk in chunks:
            await console.append(chunk.channel, chunk.data)
        restored = JobConsole(console, finished=True)
        if job.execution_id is not None:
            restored.bind_execution(job.execution_id)
        job.console = restored
        job.owner = self.owner
        job.console_name = name
        job.id = await self._insert(
            job.session_id,
            job.id,
            {
                "command": job.command,
                "cwd": job.cwd,
                "created_at": job.created_at,
                "owner": job.owner,
                "console": name,
                "ending": _outcome_of(job),
            },
        )
        self._jobs.setdefault(job.session_id, {})[job.id] = job

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
        remotes: dict[str, Job] = {}
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
        jobs: dict[int, Job] = {}
        for key, entry in entries.items():
            job = mine.pop(entry["console"], None)
            if job is None:
                job = remotes.get(entry["console"])
            if job is None:
                continue
            ending = entry.get("ending")
            if (
                job.process is None
                and job.status == JobStatus.RUNNING
                and ending is not None
            ):
                job.status, job.exit_code = _ended(ending)
            jobs[int(key)] = job
        for job in mine.values():
            if job.process is None or job.status != JobStatus.RUNNING:
                continue
            if job.console_name in held or job.id in jobs:
                self._disowned.append(job)
            else:
                jobs[job.id] = job
        self._jobs[session_id] = dict(sorted(jobs.items()))
        for job in jobs.values():
            if job.process is not None:
                await _adopt_ending(job)
            elif job.status == JobStatus.RUNNING:
                await self._refresh(job)

    def get(self, job_id: int, session_id: str = "") -> Job | None:
        return self._jobs.get(session_id, {}).get(job_id)

    def list_jobs(self, session_id: str = "") -> list[Job]:
        return list(self._jobs.get(session_id, {}).values())

    def listing(self, session_id: str = "") -> list[Job]:
        """The jobs ``jobs`` shows: a ``$( )``'s caller's, then its own.

        Args:
            session_id (str): the session whose jobs to list.
        """
        inherited = (
            self.parent.listing(session_id) if self.parent is not None else []
        )
        return inherited + self.list_jobs(session_id)

    def running_jobs(self, session_id: str = "") -> list[Job]:
        return [
            j
            for j in self.list_jobs(session_id)
            if j.status == JobStatus.RUNNING
        ]

    def all_jobs(self) -> list[Job]:
        """Every session's jobs, for the workspace-wide entry points only.

        Snapshot capture and the server summary read this; a shell
        builtin never does, since bash lists only its own jobs.
        """
        return [j for jobs in self._jobs.values() for j in jobs.values()]

    def all_running_jobs(self) -> list[Job]:
        return [j for j in self.all_jobs() if j.status == JobStatus.RUNNING]

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

        Another workspace's job is killed by ending its console; its
        owner sees the ending and stops the runner. Should the job have
        ended first, the ending it wrote stands and the job was not
        killed.

        Args:
            job_id (int): the job to stop.
            session_id (str): the session whose list names it.
            signal (int): the signal the job is stopped with; its status
                is 128 plus it, KILL's 137 by default.
        """
        job = self.get(job_id, session_id)
        if job is None or job.status != JobStatus.RUNNING:
            return False
        if job.process is not None:
            await self._stop_runner(job, job.process, signal)
            return True
        if not await self.store.alive(job.owner):
            await self._reap_owner(job.owner)
        await _mark_killed(job.console, 128 + signal)
        await self._refresh(job)
        return job.status == JobStatus.KILLED

    async def disown(self, job_id: int, session_id: str = "") -> bool:
        """Drop a job from its session's list without stopping it.

        What `disown` does in bash: the job keeps running, `jobs` no
        longer lists it and `wait` no longer knows it. The job stays on a
        side list so `kill_all` at teardown still reaches its task.

        Args:
            job_id (int): the job to drop.
            session_id (str): the session whose list names it.
        """
        job = self._jobs.get(session_id, {}).pop(job_id, None)
        if job is None:
            return False
        running = job.status == JobStatus.RUNNING
        if job.process is not None and running:
            self._disowned.append(job)
        await self._remove(session_id, {job.console_name}, disowned=running)
        return True

    async def close_session(self, session_id: str) -> list[Job]:
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
        stopped: dict[str, Job] = {}
        for _ in range(LIST_MAX_RETRIES):
            fields = await self.store.load(session_id)
            await self.sync(session_id)
            for job in self.running_jobs(session_id):
                await self.kill(job.id, session_id)
                stopped[job.console_name] = job
            for name, entry in (fields or {}).get("disowned", {}).items():
                if entry["owner"] != self.owner:
                    console = JobConsole(self.store.console(name))
                    await _mark_killed(console, KILLED_EXIT_CODE)
            if await self.store.delete(session_id, generation_of(fields)):
                self._jobs.pop(session_id, None)
                self.processes.revoke_session(session_id)
                return list(stopped.values())
        raise RuntimeError(
            f"job list of session {session_id!r} kept conflicting "
            "with another writer"
        )

    async def kill_all(self) -> list[Job]:
        """Stop every running job this table runs in every session,
        returning the ones that were running.

        Disowned jobs are stopped too: the shell forgot them, the
        workspace did not, and a teardown that left them running would
        leak their tasks. Another workspace's jobs are its own to stop.
        The reaping of lapsed owners' runs stops here as well, before the
        runtimes it reaches them through close.
        """
        self._reaping_stopped = True
        reaping = list(self._reaping)
        for task in reaping:
            task.cancel()
        await asyncio.gather(*reaping, return_exceptions=True)
        running = [j for j in self.all_running_jobs() if j.process is not None]
        for job in [*running, *self._disowned]:
            if job.status == JobStatus.RUNNING and job.process is not None:
                await _stop(job)
        self._disowned = []
        return running

    async def close(self) -> None:
        """Stop renewing this table's lease, at workspace teardown.

        Called after ``kill_all``, so every job this table ran has
        ended and other workspaces need no lease to settle them; a
        killed job whose runner is still stopping has its console ended
        now rather than at its bound. The store itself belongs to the
        workspace's state store.
        """
        for task in (self._lease, self._checking, self._publishing):
            if task is not None:
                task.cancel()
        self._lease = self._checking = self._publishing = None
        for task in list(self._reaping):
            task.cancel()
        try:
            await self.store.publish(self.owner, {})
        except Exception as exc:
            logger.debug("process record not dropped: %s", exc)
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

    async def wait(self, job_id: int, session_id: str = "") -> Job:
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
        that time (a handler finishes, a sandbox is reaped) and the
        status it leaves is the one answered, as bash's ``wait`` answers
        once the child has gone. An ending another workspace wrote is
        taken at once, before this table's watcher stops the runner. The
        runner is joined too, for at most ``STOP_WAIT_SECONDS``, so what
        its task holds is let go before this returns.

        Another workspace's job answers the status its ending records.
        While none is stored its owner's lease is checked every third of
        it, and a lapsed one ends the job as hung up.

        Args:
            job_id (int): the job to wait for.
            session_id (str): the session whose list names it.
        """
        job = self._jobs[session_id][job_id]
        if job.process is None:
            if job.status == JobStatus.RUNNING:
                await self._join_remote(job)
            return job
        await job.console.wait_finished()
        await _adopt_ending(job)
        try:
            async with asyncio.timeout(STOP_WAIT_SECONDS):
                await job.process.join()
        except TimeoutError:
            logger.debug("job %d still stopping after wait", job.id)
        return job

    async def wait_all(self, session_id: str = "") -> list[Job]:
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
        job = self._jobs.get(session_id, {}).pop(job_id, None)
        if job is not None:
            await self._remove(session_id, {job.console_name})

    async def pop_completed(self, session_id: str = "") -> list[Job]:
        """Return a session's completed/killed jobs and remove them from
        its list.

        A reader holding a job's console keeps reading it: the console
        outlives its table entry and dies with its last reader.

        Args:
            session_id (str): the session whose list is pruned.
        """
        jobs = self._jobs.get(session_id, {})
        completed = [j for j in jobs.values() if j.status != JobStatus.RUNNING]
        for j in completed:
            del jobs[j.id]
        if completed:
            await self._remove(session_id, {j.console_name for j in completed})
        return completed

    def processes_changed(self) -> None:
        """Publish the processes this table's workspace runs, now that
        one started: the publishing goes on while any runs
        (``_publish``)."""
        if self._publishing is not None and not self._publishing.done():
            return
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        self._publishing = asyncio.ensure_future(self._publish())

    async def remote_processes(self) -> dict[str, dict[str, RecordFields]]:
        """The processes other workspaces on the store run, owner to PID
        to process, as each last published them.

        A lapsed owner's are left out: whatever it ran was lost with it,
        and the native runs it left are stopped meanwhile.
        """
        if self._plane is not self:
            return await self._plane.remote_processes()
        found: dict[str, dict[str, RecordFields]] = {}
        for owner, records in (await self.store.processes()).items():
            if owner == self.owner or not records:
                continue
            if await self.store.alive(owner):
                found[owner] = records
            else:
                self._reap_later(owner)
        return found

    async def signal_remote(
        self,
        owner: str,
        pid: int,
        signal: int,
        session_id: str,
        permissions: ProcessPermissions,
    ) -> bool:
        """Signal a process another workspace runs, named by a prefix of
        its owner's id and the owner's PID: its owner stops it once it
        takes the stop, within ``PUBLISH_SECONDS``.

        Signal 0 only probes. A lapsed owner's process is gone, and the
        native runs it left are stopped instead.

        Args:
            owner (str): a prefix of the owner's id, as ``ps`` shows it.
            pid (int): the process, by the owner's PID.
            signal (int): the signal, 0 to probe.
            session_id (str): the calling session.
            permissions (ProcessPermissions): whose processes it may see
                and stop.

        Returns:
            bool: whether one live process was signalled.

        Raises:
            PermissionError: the process is one the session sees but
                may not stop.
        """
        if self._plane is not self:
            return await self._plane.signal_remote(
                owner, pid, signal, session_id, permissions
            )
        records = await self.store.processes()
        owners = [
            found
            for found, processes in records.items()
            if found != self.owner
            and found.startswith(owner)
            and str(pid) in processes
        ]
        if len(owners) > 1:
            owners = [
                found for found in owners if await self.store.alive(found)
            ]
        if len(owners) != 1:
            return False
        record = records[owners[0]][str(pid)]
        own = record.get("session") == session_id
        if permissions.list == "session" and not own:
            return False
        if not await self.store.alive(owners[0]):
            await self._reap_owner(owners[0])
            return False
        if permissions.kill == "session" and not own:
            raise PermissionError(errno.EPERM, "Operation not permitted")
        if signal != 0:
            await self.store.request_stop(owners[0], pid, signal)
        return True

    def _remote(
        self, job_id: int, session_id: str, entry: RecordFields
    ) -> Job:
        """Another workspace's job, as its list entry describes it.

        Args:
            job_id (int): the job's number.
            session_id (str): the session whose list names it.
            entry (RecordFields): the job's list entry.
        """
        return Job(
            id=job_id,
            command=entry["command"],
            cwd=entry["cwd"],
            created_at=entry["created_at"],
            console=JobConsole(self.store.console(entry["console"])),
            session_id=session_id,
            owner=entry["owner"],
            console_name=entry["console"],
        )

    async def _stop_runner(
        self, job: Job, process: ProcessHandle, signal: int
    ) -> None:
        """Stop a job this table runs and record it as killed by ``signal``.

        One that has not begun has its console ended at once: no program
        ran that could leave its own status. One that has has its console
        ended once its runner stops, or ``STOP_WAIT_SECONDS`` later.

        Args:
            job (Job): the running job.
            process (ProcessHandle): its runner.
            signal (int): the signal it is stopped with.
        """
        if not process.begun:
            await _stop(job, signal)
            await self._record_ending(job)
            self._drop_lease()
            self._drop_checking()
            return
        cancel_job(job, signal)
        job.status = JobStatus.KILLED
        job.exit_code = 128 + signal
        task = asyncio.ensure_future(self._end_killed(job, process))
        self._stopping[task] = job
        task.add_done_callback(self._stopping.pop)

    async def _end_killed(self, job: Job, process: ProcessHandle) -> None:
        """End a killed job's console once its runner has stopped, or
        ``STOP_WAIT_SECONDS`` after the kill, whichever comes first.

        A runner that settles ends the console itself, with the status
        it left; this ends it with the status the kill recorded when the
        runner never got that far (cancelled before it began) or is
        still stopping.

        Args:
            job (Job): the killed job.
            process (ProcessHandle): its runner.
        """
        try:
            async with asyncio.timeout(STOP_WAIT_SECONDS):
                await process.join()
        except TimeoutError:
            logger.debug("job %d still stopping after its kill", job.id)
        await self._end_stopping(job)

    async def _end_stopping(self, job: Job) -> None:
        """End a killed job's console with the status its kill recorded,
        unless its runner already ended it.

        Args:
            job (Job): the killed job.
        """
        if job.console.finished:
            return
        await _mark_killed(job.console, job.exit_code)
        await self._record_ending(job)
        self._drop_lease()
        self._drop_checking()

    async def _record_ending(self, job: Job) -> None:
        """Keep how a job this table ran ended in its list entry, or drop
        its disowned record, which nothing else would.

        The entry outlives the console's output, which a shared store
        expires, so a workspace that attaches after the output went
        still reads how the job ended instead of taking it as hung up.
        A failed write is logged: the console still holds the ending.

        Args:
            job (Job): a job this table ran, now ended.
        """
        ending = _outcome_of(job)
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
                        or entry.get("ending") == ending
                    ):
                        return
                    jobs[str(job.id)] = {**entry, "ending": ending}
                following = int(fields.get("next", 1))
                if await self._write(
                    job.session_id, fields, jobs, following, held
                ):
                    return
            logger.debug("job %d ending kept conflicting", job.id)
        except Exception as exc:
            logger.debug("job %d ending not kept: %s", job.id, exc)

    async def _refresh(self, job: Job) -> None:
        """Settle another workspace's job from its console's ending, or
        end it as hung up when its owner's lease lapsed with none.

        Args:
            job (Job): another workspace's running job.
        """
        outcome = await job.console.outcome()
        if outcome is None:
            if await self.store.alive(job.owner):
                return
            self._reap_later(job.owner)
            await _mark_killed(job.console, HANGUP_EXIT_CODE)
            outcome = await job.console.outcome()
            if outcome is None:
                return
        job.status, job.exit_code = _ended(outcome)

    async def _join_remote(self, job: Job) -> None:
        """Block until another workspace's job ends.

        Args:
            job (Job): another workspace's running job.
        """
        lease = self.store.lease_seconds
        while job.status == JobStatus.RUNNING:
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
                    if int(k) in dropped and "ending" not in v
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
        """Renew this table's lease while it runs jobs on a store that
        leases owners."""
        lease = self.store.lease_seconds
        if lease is None or self._lease is not None:
            return
        self._lease = asyncio.ensure_future(self._renew(lease / 3))

    def _drop_lease(self) -> None:
        """Stop renewing once every job this table runs has ended its
        console: a killed one still stopping keeps the lease, or other
        workspaces would end it as hung up."""
        if self._lease is None or any(
            j.process is not None and not j.console.finished
            for j in [*self.all_jobs(), *self._disowned]
        ):
            return
        self._lease.cancel()
        self._lease = None

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
            sessions: dict[str, list[Job]] = {}
            for job in [*self.all_jobs(), *self._disowned]:
                if job.process is not None and job.status == JobStatus.RUNNING:
                    sessions.setdefault(job.session_id, []).append(job)
            for session_id, jobs in sessions.items():
                try:
                    held = _held_consoles(await self.store.load(session_id))
                    for job in jobs:
                        if job.console_name in held:
                            continue
                        await _adopt_ending(job)
                        if (
                            job.status == JobStatus.RUNNING
                            and job.process is not None
                        ):
                            await self._stop_runner(job, job.process, 9)
                except Exception as exc:
                    logger.debug("job list check failed: %s", exc)

    def _records(self) -> dict[str, RecordFields]:
        """The live processes this workspace runs, as its record keeps
        them, each with the native runs it has going."""
        records: dict[str, RecordFields] = {}
        for handle in self.processes.live():
            info = handle.info
            records[str(info.pid)] = {
                "pid": info.pid,
                "parent": info.parent_pid,
                "group": info.group_id,
                "session": info.session_id,
                "command": info.command,
                "cwd": info.cwd.virtual,
                "started_at": info.started_at,
                "state": info.state.value,
                "execution": info.execution_id,
                "runs": list(handle.runs.values()),
            }
        return records

    async def _publish(self) -> None:
        """Publish the processes this workspace runs every
        ``PUBLISH_SECONDS`` while it runs any, renewing its lease with
        them, and stop those other workspaces asked it to stop. Once it
        runs none, its record goes and the publishing stops.

        The lease is renewed every third of it, counted in rounds, ahead
        of the record it vouches for, and the record is written again with
        it, so it outlives its store's expiry and comes back should a
        workspace have taken this one for lapsed. A failed round is logged
        and tried again the next one, and a stop that fails leaves the
        others it came with to be applied.
        """
        published: dict[str, RecordFields] | None = None
        lease = self.store.lease_seconds
        renewal = (
            max(1, int(lease / 3 / PUBLISH_SECONDS))
            if lease is not None
            else 0
        )
        rounds = due = 0
        while True:
            records = self._records()
            try:
                if renewal and rounds >= due:
                    await self.store.renew(self.owner)
                    await self.store.publish(self.owner, records)
                    published = records
                    due = rounds + renewal
                elif records != published:
                    await self.store.publish(self.owner, records)
                    published = records
                for pid, signal in await self.store.take_stops(self.owner):
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
        """Stop one of this workspace's processes another workspace
        asked to stop: a job's runner the way ``kill`` stops a job, any
        other runner directly.

        Args:
            pid (int): the process.
            signal (int): the signal it is stopped with.
        """
        for job in self.all_jobs():
            if (
                job.process is not None
                and job.pid == pid
                and job.status == JobStatus.RUNNING
            ):
                await self.kill(job.id, job.session_id, signal)
                return
        for handle in self.processes.live():
            if handle.info.pid == pid:
                handle.terminate(signal)
                return

    def _reap_later(self, owner: str) -> None:
        """Stop the native runs a lapsed owner left, without waiting.

        Args:
            owner (str): the lapsed owner.
        """
        if self._reaping_stopped or owner in self._reaped:
            return
        self._reaped.add(owner)
        task = asyncio.ensure_future(self._reap_owner(owner))
        self._reaping.add(task)
        task.add_done_callback(self._reaping.discard)

    async def _reap_owner(self, owner: str) -> None:
        """Stop the native runs a lapsed owner left, those this
        workspace reaches, and keep its record holding only the rest, for
        a workspace that reaches them. The owner's lease is checked again
        before each run is stopped, so one that renewed meanwhile keeps
        its runs, and its record as it is.

        Args:
            owner (str): the lapsed owner.
        """
        try:
            records = (await self.store.processes()).get(owner, {})
            left: list[dict[str, JsonValue]] = []
            for record in records.values():
                for run in record["runs"]:
                    if await self.store.alive(owner):
                        return
                    if self.reaper is None or await self.reaper([run], 15):
                        left.append(run)
            kept = {
                pid: {
                    **record,
                    "runs": [r for r in record["runs"] if r in left],
                }
                for pid, record in records.items()
                if any(run in left for run in record["runs"])
            }
            if not await self.store.alive(owner):
                await self.store.publish(owner, kept)
        except Exception as exc:
            logger.debug("lapsed owner %s not reaped: %s", owner, exc)

    async def _renew(self, interval: float) -> None:
        """Renew this table's lease every ``interval`` seconds, with the
        consoles of the jobs it still runs, so a quiet one keeps its
        output while this table lives.

        A failed renewal is logged and retried: should the lease lapse
        meanwhile, other workspaces end this table's jobs as hung up and
        the watchers here stop them, so the two never disagree.

        Args:
            interval (float): seconds between renewals.
        """
        while True:
            await asyncio.sleep(interval)
            try:
                await self.store.renew(
                    self.owner,
                    [
                        j.console_name
                        for j in [*self.all_jobs(), *self._disowned]
                        if j.process is not None and not j.console.finished
                    ],
                )
            except Exception as exc:
                logger.debug("job lease renewal failed: %s", exc)
