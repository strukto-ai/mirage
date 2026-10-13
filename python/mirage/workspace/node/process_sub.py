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

from mirage.core.dev.pipe import DevicePipe
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.errors import PipeClosed
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.shell.console import Channel, JobConsole, Terminal
from mirage.shell.helpers import (
    get_process_sub_body,
    get_process_sub_direction,
)
from mirage.shell.types import ProcessSubDirection, TSNodeLike
from mirage.vfs.dev.dev import DevVFS
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.frame import ProcessSubLine
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.node.types import Substitution
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)


class SubstitutionConsole(JobConsole):
    def __init__(self, endpoint: DevicePipe, target: JobConsole) -> None:
        super().__init__()
        self.endpoint = endpoint
        self.target = target

    async def emit(self, channel: Channel, data: bytes) -> None:
        if channel == Channel.STDOUT and self.endpoint.readable:
            try:
                await self.endpoint.pipe.write(data)
            except PipeClosed as exc:
                raise asyncio.CancelledError() from exc
        else:
            await self.target.emit(channel, data)


async def _close_readers(endpoint: DevicePipe) -> None:
    """Close the streams readers opened on a pipe that ends with its
    command: a later read finds the end of input either way, and nothing
    is left open for the event loop to finalize.

    Args:
        endpoint (DevicePipe): the substitution's pipe.
    """
    readers = list(endpoint.readers)
    endpoint.readers.clear()
    for reader in readers:
        try:
            await reader.aclose()
        except RuntimeError:
            # A reader still mid-pull in another task (a background job)
            # finds the end of input once that pull returns.
            logger.debug("a pipe reader was still reading", exc_info=True)


class ProcessSubScope:
    """Own one command node's virtual descriptors and auxiliary children."""

    def __init__(
        self,
        context: EvaluationContext,
        registry: MountRegistry,
        sink: JobConsole | None = None,
    ) -> None:
        self.context = context
        self.registry = registry
        self.sink = sink
        self.capture = Terminal()
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
        output = SubstitutionConsole(endpoint, self.sink or self.capture)
        task = asyncio.create_task(
            self._run(node, execute_line, endpoint, output)
        )
        self.held.append(Substitution(dev, path, allocation, endpoint, task))
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
        held = self._held_inputs()
        kept = {} if failed else held
        for child in self.held:
            if child.path in kept:
                continue
            if failed or child.endpoint.readable:
                child.endpoint.pipe.close_reader()
                child.task.cancel()
            else:
                child.endpoint.pipe.end()
        try:
            results = await asyncio.gather(
                *(
                    lines.load_rest()
                    for readers in kept.values()
                    for lines in readers
                ),
                *(child.task for child in self.held),
                return_exceptions=True,
            )
            for result in results:
                if isinstance(result, BaseException) and not isinstance(
                    result, asyncio.CancelledError
                ):
                    raise result
        finally:
            for child in self.held:
                await _close_readers(child.endpoint)
                child.dev.release_input(child.path, child.allocation)

    def _held_inputs(self) -> dict[str, list[AsyncLineIterator]]:
        """This scope's input pipes that a shell descriptor still reads
        after the command (``exec 3<"$1"``, or a dup), with the line
        buffers reading each, which load the rest. The descriptors stop
        naming them, as the paths are free once this command ends.
        """
        inputs = {c.path for c in self.held if c.endpoint.readable}
        held: dict[str, list[AsyncLineIterator]] = {}
        for descriptor in self.context.session.descriptors.values():
            source = descriptor.source
            if (
                source is None
                or source.pipe is None
                or source.pipe.virtual not in inputs
            ):
                continue
            readers = held.setdefault(source.pipe.virtual, [])
            if all(source.lines is not lines for lines in readers):
                readers.append(source.lines)
            source.pipe = None
        return held

    async def settle(self) -> tuple[bytes, bytes]:
        """End the substitutions as a finished command does, for a node
        ``exit``, ``return`` or ``break`` leaves, and return what they
        wrote to the capture, stdout then stderr.
        """
        await self.close()
        return self.capture.take()

    def own(
        self, stdout: ByteSource | None, io: IOResult, node: ExecutionNode
    ) -> ByteSource | None:
        return self._output(stdout, io, node) if self.held else stdout

    async def _output(
        self, stdout: ByteSource | None, io: IOResult, node: ExecutionNode
    ) -> AsyncIterator[bytes]:
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
            out, err = self.capture.take()
            if err:
                io.stderr = await materialize(io.stderr) + err
                node.stderr = io.stderr
            if completed and out:
                yield out
