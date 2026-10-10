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

from mirage.process.supervisor import ProcessSupervisor
from mirage.shell.bytes import encode_text
from mirage.shell.console import (
    KILLED_OUTCOME,
    Channel,
    JobConsole,
    exit_outcome,
)
from mirage.shell.job_table.constants import KILLED_EXIT_CODE
from mirage.shell.job_table.types import (
    ConsoleFactory,
    Job,
    JobRunner,
    JobStatus,
)
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


def cancel_job(job: Job) -> None:
    """Ask a job to stop, from any thread, without waiting for it.

    Routed through the task's own loop because the caller is often
    somewhere else entirely: a sync teardown path, an agent adapter on a
    pool thread, a server request handler. Tolerates a loop that has
    already shut down, which is the normal case during interpreter exit.

    Args:
        job (Job): the job to cancel.
    """
    try:
        if job.process is not None:
            job.process.terminate()
        elif job.task is not None:
            job.task.get_loop().call_soon_threadsafe(job.task.cancel)
    except RuntimeError as exc:
        # The loop that was running this job is gone, so the job is too.
        logger.debug("job %d loop is gone: %s", job.id, exc)


async def _mark_killed(console: JobConsole) -> None:
    """Write the kill marker and the ending chunk.

    Args:
        console (JobConsole): the killed job's console.
    """
    await console.emit(Channel.STDERR, b"Killed")
    await console.finish(KILLED_OUTCOME)


async def _settle(run: JobRunner, job: Job) -> int:
    """Run a job to completion and record how it ended.

    A job settles exactly once. Normally that happens here, in the job's
    own task, and the runner only produces output. The exception is
    ``kill``, which settles the job itself so the caller never has to
    wait for a runner that may not notice it was cancelled; a runner
    still unwinding afterwards must not reopen or relabel the job, which
    is what the status checks below enforce.

    Status is set before the console is finished, so a reader released by
    the ending chunk always sees settled fields.

    Args:
        run (JobRunner): produces the job's output and its result.
        job (Job): the job being run.
    """
    try:
        io_result, _ = await run(job)
    except asyncio.CancelledError:
        if job.status != JobStatus.RUNNING:
            raise
        job.status = JobStatus.KILLED
        job.exit_code = KILLED_EXIT_CODE
        # This task is already unwinding from a cancel, and a store that
        # suspends (Redis) would take a second cancellation mid-write
        # and lose the marker readers are parked on. The shielded task
        # keeps running to completion even if this one is cancelled
        # again; RAM completes without ever suspending either way.
        marker = asyncio.ensure_future(_mark_killed(job.console))
        while not marker.done():
            try:
                await asyncio.shield(marker)
            except asyncio.CancelledError:
                logger.debug(
                    "job %d cancelled again while marking killed", job.id
                )
        marker.result()
        raise
    except Exception as exc:
        # Recorded as the job's output and exit status rather than
        # re-raised: nobody awaits this task, so re-raising would only
        # strand the error in an unretrieved future.
        logger.debug("background job %d failed: %s", job.id, exc)
        if job.status != JobStatus.RUNNING:
            return 1
        job.status = JobStatus.COMPLETED
        job.exit_code = 1
        await job.console.emit(Channel.STDERR, encode_text(str(exc)))
        await job.console.finish(exit_outcome(1))
        return 1
    if job.status != JobStatus.RUNNING:
        return io_result.exit_code
    job.exit_code = io_result.exit_code
    job.status = JobStatus.COMPLETED
    await job.console.finish(exit_outcome(job.exit_code))
    return io_result.exit_code


class JobTable:
    """The shell's job table: bash's per-shell job list, one list per session.

    This is job control, not a process table. A job is numbered ``%N``
    within the session that launched it, numbering restarts at 1 once
    that session's list empties (GNU bash), and ``jobs``, ``wait``,
    ``fg``, ``kill`` and ``disown`` only ever see the calling session's
    list, exactly as one bash never lists another bash's jobs. Runner
    PIDs are tracked separately: ``$!`` and ``jobs -l`` report the
    managed PID, while ``%N`` names a session-local job number. A job's
    KILLED outcome ends its console, while ``job.process`` stays STOPPING
    until the runner actually finishes.

    The table is still owned by the workspace rather than by a session,
    because the workspace owns the tasks: teardown must stop every job
    in every session (``kill_all``), snapshot capture reads every
    finished one (``all_jobs``), and a disowned job keeps running after
    its shell forgot it. Those are the only cross-session views; every
    other method takes the session whose list it reads, and the empty
    session id is the list a caller with no session (a bare table in a
    test) shares.
    """

    def __init__(
        self,
        console_factory: ConsoleFactory | None = None,
        processes: ProcessSupervisor | None = None,
        parent: "JobTable | None" = None,
    ) -> None:
        """Create a table, optionally choosing where consoles live.

        Args:
            console_factory (ConsoleFactory | None): builds each new
                job's console from its job id. None means an in-memory
                console per job. A factory must hand every job a fresh
                backing: ids restart at 1 when a session's list empties
                (GNU numbering) and two sessions can both hold a job 1,
                so a store keyed on the id alone gets reused, and a
                reused stream replays the previous job's chunks, ending
                chunk included. The table tracks what the factory
                builds and ``close_consoles`` releases it at workspace
                teardown, because a config-provisioned store (a Redis
                client per job) is invisible to the embedder; a console
                still outlives its table entry, so ``reap`` never closes
                one.
            processes (ProcessSupervisor | None): where the jobs run.
            parent (JobTable | None): the table of the shell a ``$( )``
                is part of, whose jobs ``jobs`` still lists there, as
                bash's does; its ``wait`` and ``kill`` reach none of them.
        """
        self.parent = parent
        self.processes = processes or ProcessSupervisor()
        self._jobs: dict[str, dict[int, Job]] = {}
        self._next_ids: dict[str, int] = {}
        self._console_factory = console_factory
        self._factory_consoles: list[JobConsole] = []
        # The table whose ``close_consoles`` releases what the factory
        # builds for this one: itself, or the table a child came from.
        self._console_owner: JobTable = self
        # Jobs `disown` removed from the table while they still run. The
        # shell no longer lists, waits for or reports them, but the
        # workspace still owns their tasks, so teardown can stop them.
        self._disowned: list[Job] = []

    def child(self, parent: "JobTable | None" = None) -> "JobTable":
        """A table for a child shell (``bash -c``, a script, ``( )``,
        ``$( )``): a job list of its own on the same processes, whose
        jobs get their consoles from this table's factory, released at
        teardown with this table's.

        Args:
            parent (JobTable | None): the table a ``$( )`` still lists
                in ``jobs``.
        """
        table = JobTable(self._console_factory, self.processes, parent)
        table._console_owner = self._console_owner
        return table

    def submit(
        self,
        command: str,
        run: JobRunner,
        cwd: str,
        agent: str = "unknown",
        session_id: str = "",
        parent_pid: int | None = None,
        limit: int | None = None,
    ) -> Job:
        """Register a job in its session's list and start it.

        Reserve a process slot before allocating a console. The runner
        is deferred until the job and console are ready; failed setup
        cancels the reservation without entering the supplied runner.
        Only fully initialized jobs join the table.

        Args:
            command (str): the command line being run.
            run (JobRunner): produces the job's output and its result.
            cwd (str): working directory the job was started from.
            agent (str): agent that started the job.
            session_id (str): session whose job list the job joins.
            parent_pid (int | None): the runner that started the job.
            limit (int | None): the session's process cap
                (``processes.max``); None for no cap.

        Raises:
            BlockingIOError: the session is at its process cap.
        """
        jobs = self._jobs.setdefault(session_id, {})
        if not jobs:
            # GNU bash restarts job numbering at 1 once the job list
            # empties. Without this, reaping after a targeted `wait`
            # would leave a later `wait %1` pointing at nothing.
            self._next_ids[session_id] = 1
        job_id = self._next_ids.setdefault(session_id, 1)
        job: Job | None = None

        async def execute() -> int:
            if job is None:
                return KILLED_EXIT_CODE
            if job.status == JobStatus.RUNNING:
                return await _settle(run, job)
            return job.exit_code

        process = self.processes.start(
            session_id=session_id,
            command=command,
            cwd=PathSpec.from_str_path(cwd),
            run=execute,
            parent_pid=parent_pid,
            limit=limit,
        )
        try:
            if self._console_factory is None:
                console = JobConsole()
            else:
                console = self._console_factory(job_id)
                self._console_owner._factory_consoles.append(console)
            console.bind_execution(process.info.execution_id)
            job = Job(
                id=job_id,
                command=command,
                task=None,
                cwd=cwd,
                agent=agent,
                session_id=session_id,
                console=console,
            )
        except Exception:
            process.terminate()
            raise
        job.process = process
        job.task = job.process.task
        jobs[job_id] = job
        self._next_ids[session_id] = job_id + 1
        return job

    def load(self, job: Job) -> None:
        """Insert a finished job restored from a snapshot into its session.

        Args:
            job (Job): the restored job.
        """
        self._jobs.setdefault(job.session_id, {})[job.id] = job
        if job.id >= self._next_ids.get(job.session_id, 1):
            self._next_ids[job.session_id] = job.id + 1

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

    async def kill(self, job_id: int, session_id: str = "") -> bool:
        """Stop a job and record it as killed.

        The cancel is routed through the task's own loop, never awaited
        directly, because a caller may be on a different thread and loop
        than the job (an agent adapter reaching in through the sync
        bridge, a server request handler); awaiting a foreign task would
        raise.

        The job is settled here rather than by joining the cancelled
        runner. Cancellation is only observed where someone checks it,
        which today is the executor between nodes and the commands that
        take it, so a job sitting inside one long command would not
        notice until it finished on its own. Joining would hang the shell
        on exactly the runaway job the caller is trying to stop.

        The console's own guards make the early ending safe: emits after
        the ending chunk are dropped, so a runner still unwinding cannot
        append past its own death, and ``_settle`` returns early once the
        job is no longer RUNNING so it cannot relabel it.

        Args:
            job_id (int): the job to stop.
            session_id (str): the session whose list names it.
        """
        job = self.get(job_id, session_id)
        if job is None or job.status != JobStatus.RUNNING:
            return False
        if job.task is None:
            return False
        cancel_job(job)
        job.status = JobStatus.KILLED
        job.exit_code = KILLED_EXIT_CODE
        await job.console.emit(Channel.STDERR, b"Killed")
        await job.console.finish(KILLED_OUTCOME)
        return True

    def disown(self, job_id: int, session_id: str = "") -> bool:
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
        if job.status == JobStatus.RUNNING:
            self._disowned.append(job)
        return True

    async def close_session(self, session_id: str) -> list[Job]:
        """Drop a session's job list when the session closes, stopping
        what is still running, and return what was stopped.

        What happens to a bash's jobs when that bash exits: they are
        hung up, and a later shell that reuses the same id starts from
        an empty list numbered from 1 rather than inheriting jobs it
        never launched, under a profile it may not share. Session closure
        revokes its process entry points and stops disowned runners too.

        Args:
            session_id (str): the session being closed.
        """
        running = self.running_jobs(session_id)
        for job in running:
            await self.kill(job.id, session_id)
        self.processes.revoke_session(session_id)
        self._jobs.pop(session_id, None)
        self._next_ids.pop(session_id, None)
        return running

    async def kill_all(self) -> list[Job]:
        """Stop every running job in every session, returning the ones
        that were running.

        Disowned jobs are stopped too: the shell forgot them, the
        workspace did not, and a teardown that left them running would
        leak their tasks.
        """
        running = self.all_running_jobs()
        for job in running:
            await self.kill(job.id, job.session_id)
        for job in self._disowned:
            if job.status == JobStatus.RUNNING and job.task is not None:
                cancel_job(job)
                job.status = JobStatus.KILLED
                job.exit_code = KILLED_EXIT_CODE
                await job.console.emit(Channel.STDERR, b"Killed")
                await job.console.finish(KILLED_OUTCOME)
        self._disowned = []
        return running

    async def close_consoles(self) -> None:
        """Close every console the factory built, releasing its store.

        Called by workspace teardown after ``kill_all``. Only tracked,
        factory-built consoles are closed: the default in-memory ones
        hold nothing, while a factory-provisioned store keeps a client
        open per job (in Node an open client holds the process alive).
        Closing also releases any reader still parked on one.
        """
        consoles = self._factory_consoles
        self._factory_consoles = []
        for console in consoles:
            await console.close()

    async def wait(self, job_id: int, session_id: str = "") -> Job:
        """Block until a job ends, then return it.

        Joined on the console's ending chunk, never on the status field:
        ``kill`` and ``_settle`` both flip the status before their final
        appends, so a status-based return could let the caller snapshot
        and reap the job before ``Killed`` or the ending chunk is
        persisted (a waiter on another loop today, any store that
        suspends tomorrow). A restored job has no task and its console
        already holds the ending chunk, so it returns without waiting.

        Args:
            job_id (int): the job to wait for.
            session_id (str): the session whose list names it.
        """
        job = self._jobs[session_id][job_id]
        if job.task is None:
            return job
        await job.console.wait_finished()
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

    def reap(self, job_id: int, session_id: str = "") -> None:
        """Remove one job from its session's list.

        What a targeted ``wait``/``fg`` does once the job has ended,
        matching GNU bash, where a job waited on by id is deleted from
        the job list, so a later ``jobs`` or ``wait %N`` no longer finds
        it.

        Args:
            job_id (int): the job to remove.
            session_id (str): the session whose list names it.
        """
        self._jobs.get(session_id, {}).pop(job_id, None)

    def pop_completed(self, session_id: str = "") -> list[Job]:
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
        return completed
