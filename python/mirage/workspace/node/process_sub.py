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
from collections.abc import AsyncIterator
from functools import partial

from mirage.core.dev.pipe import DevicePipe
from mirage.execution.job import JobTable
from mirage.execution.job.waits import Hold
from mirage.execution.process.handle import ProcessHandle
from mirage.io.errors import PipeClosed
from mirage.io.pipe import BytePipe
from mirage.io.types import ByteSource, materialize
from mirage.shell.console import Channel, JobConsole
from mirage.shell.constants import FD_STDOUT
from mirage.shell.helpers import (
    get_process_sub_body,
    get_process_sub_direction,
)
from mirage.shell.parse.program import retain_programs
from mirage.shell.types import ProcessSubDirection, TSNodeLike
from mirage.vfs.dev.dev import DevVFS
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.background import capture_hold, job_streams
from mirage.workspace.executor.builtins.exec import ForkRoute
from mirage.workspace.frame import ProcessSubLine
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.node.types import Substitution
from mirage.workspace.session import SessionState
from mirage.workspace.session.session import close_readers, let_go_held

logger = logging.getLogger(__name__)


class SubstitutionConsole(JobConsole):
    def __init__(self, endpoint: DevicePipe, target: JobConsole) -> None:
        super().__init__()
        self.endpoint = endpoint
        self.target = target

    def pipe_for(self, channel: Channel) -> BytePipe | None:
        if channel == Channel.STDOUT and self.endpoint.readable:
            return self.endpoint.pipe
        return self.target.pipe_for(channel)

    async def emit(self, channel: Channel, data: bytes) -> None:
        if channel == Channel.STDOUT and self.endpoint.readable:
            await self.endpoint.pipe.write(data)
        else:
            await self.target.emit(channel, data)


class ProcessSubScope:
    """Own one command node's virtual descriptors and auxiliary children."""

    def __init__(
        self,
        context: EvaluationContext,
        registry: MountRegistry,
        jobs: JobTable,
    ) -> None:
        self.jobs = jobs
        self.context = context
        self.registry = registry
        self.held: list[Substitution] = []
        self.closed = False

    async def open(
        self, node: TSNodeLike, execute_line: ProcessSubLine
    ) -> str:
        root, _, _ = self.registry.resolve("/dev/null")
        assert isinstance(root, DevVFS)
        dev = root.for_session(self.context.session.session_id)
        endpoint = DevicePipe(
            get_process_sub_direction(node) != ProcessSubDirection.OUTPUT
        )
        path, allocation = dev.allocate_input(endpoint)
        session = self.context.session
        # A producer is a child of the shell, as bash forks it: what it
        # writes past its pipe goes where that shell's jobs write, into
        # the statement running then or, once that has ended, on out.
        jobs = ForkRoute(session.job_output or session.tty.jobs, session)
        output = SubstitutionConsole(endpoint, jobs)
        writers = self.context.frame.writers
        begun: asyncio.Future[None] = (
            asyncio.get_running_loop().create_future()
        )
        holds: list[Hold] = []
        inherited: list[Substitution] = []

        def started(process: ProcessHandle, shell: SessionState) -> None:
            inherited.extend(session.hold_substitutions(shell))
            pid = process.record.pid
            if endpoint.readable:
                writers.append((path, pid))
            session.last_bg_job_id = pid
            self.jobs.track_substitution(process, task)
            shell.holds.extend(holds)
            if not begun.done():
                begun.set_result(None)

        release = retain_programs([node])
        task = asyncio.create_task(
            self._run(
                node, partial(execute_line, started=started), endpoint, output
            )
        )

        def finished(task: asyncio.Task[None]) -> None:
            release()
            let_go_held(inherited)
            if (
                not task.cancelled()
                and (error := task.exception()) is not None
            ):
                logger.debug("process substitution failed", exc_info=error)

        task.add_done_callback(finished)
        self.held.append(
            Substitution(
                path,
                endpoint,
                task,
                begun,
                partial(dev.release_input, path, allocation),
            )
        )
        # Like a job, it holds open a capture (`$( )`, a pipe stage) one of
        # its streams leads into, which waits for it until it ends or its
        # shell points them elsewhere.
        streams = job_streams(node, session)
        if endpoint.readable:
            streams.pop(FD_STDOUT, None)
        waits = session.job_waits
        if waits is not None:

            async def ended() -> None:
                await asyncio.wait((task,))

            hold = capture_hold(waits, jobs, streams, ended)
            if hold is not None:
                holds.append(hold)
        # A `<( )` the command reads starts first, as bash forks it, so
        # the command's program knows the process writing the path; a
        # `>( )` starts after the command, so it cannot close its pipe
        # before the command's first write.
        if endpoint.readable:
            await asyncio.wait(
                (begun, task), return_when=asyncio.FIRST_COMPLETED
            )
            if task.done():
                await task
        return path

    async def _run(
        self,
        node: TSNodeLike,
        execute_line: ProcessSubLine,
        endpoint: DevicePipe,
        output: JobConsole,
    ) -> None:
        try:
            io = await execute_line(
                get_process_sub_body(node),
                sink=output,
                stdin=None if endpoint.readable else endpoint.pipe.stream(),
            )
            await output.emit(Channel.STDOUT, await materialize(io.stdout))
            await output.emit(Channel.STDERR, await materialize(io.stderr))
        except PipeClosed:
            # The command's reader deliberately ended before its producer.
            if not endpoint.pipe.closed_reader:
                raise
        finally:
            if endpoint.readable:
                endpoint.pipe.end()
            else:
                endpoint.pipe.close_reader()

    async def close(self, failed: bool = False) -> None:
        if self.closed:
            return
        self.closed = True
        session = self.context.session
        kept = (
            set()
            if failed
            else {c.path for c in self.held} & session.named_pipes()
        )
        ending = [child for child in self.held if child.path not in kept]
        # A pipe a descriptor of the shell still names (`exec 3< <(cmd)`,
        # `exec > >(tee log)`, `exec 3<"$1"` in a function given one) goes
        # on with the shell, which ends it once no descriptor names it. It
        # has started by then, as bash forks it, so `$!` and `wait` know it.
        for child in self.held:
            if child.path in kept:
                session.keep_substitution(child)
                await asyncio.wait(
                    (child.begun, child.task),
                    return_when=asyncio.FIRST_COMPLETED,
                )
        for child in ending:
            if failed or child.endpoint.readable:
                child.endpoint.pipe.close_reader()
                if failed:
                    child.task.cancel()
            else:
                child.endpoint.pipe.end()
        try:
            results = await asyncio.gather(
                *(
                    child.task
                    for child in ending
                    if failed
                    or not child.endpoint.readable
                    or child.task.done()
                ),
                return_exceptions=True,
            )
            for result in results:
                if isinstance(result, BaseException) and not isinstance(
                    result, asyncio.CancelledError
                ):
                    raise result
        finally:
            for child in ending:
                await close_readers(child.endpoint)
                child.release()

    def own(self, stdout: ByteSource | None) -> ByteSource | None:
        return self._output(stdout) if self.held else stdout

    async def _output(self, stdout: ByteSource | None) -> AsyncIterator[bytes]:
        completed = False
        try:
            if isinstance(stdout, bytes):
                if stdout:
                    yield stdout
            elif stdout is not None:
                async for chunk in stdout:
                    yield chunk
            completed = True
        finally:
            await self.close(not completed)
