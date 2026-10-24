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

from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from contextlib import aclosing
from functools import partial

from mirage.commands.builtin.generic_bind.dispatch import caller_stream
from mirage.commands.builtin.utils.stream import is_stdin, resolve_source
from mirage.context.session_context import current_caller
from mirage.errors.classify import classify, failure_text
from mirage.errors.constants import FS_ERRORS, WALK_ERRORS
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.io.cooperative import chunks
from mirage.io.spool import ByteSpool, spooled_pair
from mirage.io.types import ByteSource
from mirage.io.writer import ByteWriter
from mirage.rs.stream import Served
from mirage.runtime.types import DispatchFn, ShellFn
from mirage.shell.bytes import byte_view, text_view
from mirage.shell.join import shell_join
from mirage.types import JsonValue, PathSpec, ReadStreamFn

STDIN_NAMES = frozenset({"-", "/dev/stdin"})


async def _spooled(spool: ByteSpool) -> AsyncIterator[bytes]:
    async with spool:
        async for chunk in spool.stream():
            yield chunk


def _failure(exc: BaseException) -> dict[str, JsonValue]:
    """A failed request's reply: the failure's words and the condition it
    names, when the vocabulary names one."""
    reply: dict[str, JsonValue] = {"error": byte_view(failure_text(exc))}
    condition = classify(exc)
    if condition is not None:
        reply["errno"] = condition.name
    return reply


class StreamHost:
    """The files and commands a mirage-rs stream reaches, through the
    workspace.

    An input opens on its first read. An operand still holding its
    command-line spelling reads through the mount's own reader, the way
    it was resolved, unless another mount serves it; every other name
    reads through the dispatcher, as writes go through it. Every stdin
    reader (``-``, ``/dev/stdin`` and a command run without input of its
    own) shares one cursor, so none replays what another read. A write is
    held until the stream flushes it.

    Args:
        operands (Sequence[PathSpec]): The operands as classified.
        stream (ReadStreamFn): The mount's reader for an operand.
        stdin (ByteSource | None): The command's standard input.
        dispatch (DispatchFn | None): The workspace dispatcher.
        cwd (PathSpec): What relative names resolve against.
        shell (ShellFn | None): Runs a nested line in the session.
        local (Callable[[PathSpec], bool]): Whether the mount serves an
            operand.
        dash (bool): an operand ``-`` names stdin (see ``is_stdin``).
    """

    def __init__(
        self,
        operands: Sequence[PathSpec],
        stream: ReadStreamFn,
        stdin: ByteSource | None,
        dispatch: DispatchFn | None,
        cwd: PathSpec,
        shell: ShellFn | None,
        local: Callable[[PathSpec], bool],
        dash: bool = True,
    ) -> None:
        self.operands = operands
        self.dash = dash
        self.stream = stream
        self.stdin = resolve_source(stdin)
        self.dispatch = dispatch
        self.cwd = cwd
        self.shell = shell
        self.local = local
        self.caller = current_caller()
        self.inputs: dict[int, AsyncIterator[bytes]] = {}
        self.spools: dict[int, ByteSpool] = {}
        self.outputs: dict[str, ByteWriter] = {}
        self.errors = ByteSpool()

    async def stdin_view(self) -> AsyncIterator[bytes]:
        async for chunk in self.stdin:
            yield chunk

    async def read_path(
        self, name: str | PathSpec, local: bool = False
    ) -> AsyncIterator[bytes]:
        """Read a file.

        Args:
            name (str | PathSpec): The file.
            local (bool): An operand this mount's backend serves.
        """
        if self.dispatch is None and not local:
            raise FileNotFoundError(posix_phrase(FsCondition.ENOENT))
        path = PathSpec.from_str_path(name, cwd=self.cwd.virtual)
        stream = (
            self.stream(path)
            if local or self.dispatch is None
            else caller_stream(self.dispatch, self.caller, path)
        )
        async with aclosing(chunks(stream)) as source:
            async for chunk in source:
                yield chunk

    def open_input(
        self, name: str, operand: int | None, file: bool = False
    ) -> AsyncIterator[bytes]:
        """Open an input by name.

        Args:
            name (str): The file name, ``-`` or ``/dev/stdin`` for stdin.
            operand (int | None): The operand, from 1, the name came from.
            file (bool): a file a script names, which no spelling of
                stdin stands for.
        """
        if file:
            return self.read_path(name)
        if operand is not None and 0 < operand <= len(self.operands):
            path = self.operands[operand - 1]
            if path.raw_path == name:
                if is_stdin(path, self.dash):
                    return self.stdin_view()
                return self.read_path(path, self.local(path))
        if name in STDIN_NAMES:
            return self.stdin_view()
        return self.read_path(name)

    async def flush_output(
        self, name: str | None = None
    ) -> dict[str, JsonValue] | None:
        """Commit one file's writes, or every file's; the first failure
        stops it, and its reply, naming the file, is returned.

        Args:
            name (str | None): The file as the stream named it.
        """
        for key in list(self.outputs) if name is None else [name]:
            writer = self.outputs.pop(key, None)
            if writer is None:
                continue
            try:
                await writer.finish()
            except WALK_ERRORS as exc:
                return {**_failure(exc), "path": key}
        return None

    async def _append(self, path: PathSpec, source: ByteSource) -> None:
        assert self.dispatch is not None
        await self.dispatch("append", path, data=source)

    async def serve(
        self, request: Mapping[str, JsonValue], data: bytes
    ) -> Served:
        """Do one request a stream makes.

        Args:
            request (Mapping[str, JsonValue]): What the stream asks.
            data (bytes): The bytes it carries.
        """
        op = request["op"]
        fd = request.get("fd")
        if op == "read" and isinstance(fd, int):
            return await self._read(fd, request)
        if op == "close" and isinstance(fd, int):
            source = self.inputs.pop(fd, None)
            if source is not None:
                await _close(source)
            return Served({})
        if op == "write":
            return await self._write(request, data)
        if op == "flush":
            path = request.get("path")
            failure = await self.flush_output(
                path if isinstance(path, str) else None
            )
            return Served(failure or {})
        if op == "spool" and isinstance(fd, int):
            await self.spools.setdefault(fd, ByteSpool()).append(data)
            return Served({})
        if op == "emit" and isinstance(fd, int):
            spool = self.spools.pop(fd, None)
            return Served(
                {}, output=None if spool is None else _spooled(spool)
            )
        if op == "run":
            return await self._run(request)
        raise ValueError(f"unknown stream request: {op}")

    async def _read(self, fd: int, request: Mapping[str, JsonValue]) -> Served:
        source = self.inputs.get(fd)
        path = request.get("path")
        if source is None and isinstance(path, str):
            operand = request.get("operand")
            source = self.open_input(
                text_view(path),
                operand if isinstance(operand, int) else None,
                request.get("file") is True,
            )
            self.inputs[fd] = source
        if source is None:
            return Served({"end": True})
        try:
            chunk = await anext(source, None)
        except Exception as exc:
            # A failure the error vocabulary names is the file's own.
            if not isinstance(exc, FS_ERRORS) and classify(exc) is None:
                raise
            del self.inputs[fd]
            return Served(_failure(exc))
        if chunk is None:
            del self.inputs[fd]
            return Served({"end": True})
        return Served({}, bytes(chunk))

    async def _replace(self, path: PathSpec, source: ByteSource) -> None:
        assert self.dispatch is not None
        await self.dispatch("write", path, data=source, atomic=True)

    async def _write(
        self, request: Mapping[str, JsonValue], data: bytes
    ) -> Served:
        """Write to a file: ``append`` adds to it, otherwise it is emptied
        first, every held write committed before; ``atomic`` replaces it
        whole, once flushed, with what this and later writes carry;
        ``spool`` writes that spool's bytes past its first ``skip`` and
        drops it."""
        if self.dispatch is None:
            return Served({"fatal": "file output requires a workspace"})
        name = str(request["path"])
        path = PathSpec.from_str_path(text_view(name), cwd=self.cwd.virtual)
        spool_fd = request.get("spool")
        spool = (
            self.spools.pop(spool_fd, None)
            if isinstance(spool_fd, int)
            else None
        )
        try:
            if request.get("atomic"):
                if (held := self.outputs.pop(name, None)) is not None:
                    await held.abort()
                self.outputs[name] = ByteWriter(partial(self._replace, path))
            elif not request.get("append"):
                if failure := await self.flush_output():
                    return Served(failure)
                await self.dispatch("write", path, data=b"")
            writer = self.outputs.get(name)
            if writer is None and (data or spool is not None):
                writer = self.outputs[name] = ByteWriter(
                    partial(self._append, path)
                )
            if writer is not None and data:
                await writer.write(data)
            if writer is not None and spool is not None:
                skip = request.get("skip")
                offset = skip if isinstance(skip, int) else 0
                async for chunk in spool.stream(offset):
                    await writer.write(chunk)
        except WALK_ERRORS as exc:
            return Served(_failure(exc))
        finally:
            if spool is not None:
                await spool.close()
        return Served({})

    async def _run(self, request: Mapping[str, JsonValue]) -> Served:
        """Run a command line in a subshell of the session, as sh -c would;
        ``eval`` takes the line whole, so an empty one, a comment or a line
        ending in a backslash runs as ``sh -c`` would run it."""
        if self.shell is None:
            return Served({"fatal": "running a command requires a workspace"})
        stdin_fd = request.get("stdin")
        # A pipe nothing was printed to has no spool, and is still its
        # command's whole input.
        spool = (
            self.spools.pop(stdin_fd, ByteSpool())
            if isinstance(stdin_fd, int)
            else None
        )
        source: ByteSource = (
            self.stdin_view() if spool is None else spool.stream()
        )
        command = text_view(str(request["command"]))
        try:
            io = await self.shell(
                f"( {shell_join(['eval', command])} )", source
            )
            stdout, stderr = await spooled_pair(io.stdout, io.stderr)
        finally:
            if spool is not None:
                await spool.close()
        await self.errors.fill(stderr or b"")
        reply: dict[str, JsonValue] = {"status": io.exit_code}
        stdout_fd = request.get("stdout")
        if isinstance(stdout_fd, int):
            self.inputs[stdout_fd] = chunks(stdout or b"")
            return Served(reply)
        return Served(reply, output=stdout)

    async def close(self) -> None:
        """Let go of every input, spool and uncommitted write."""
        writers = list(self.outputs.values())
        self.outputs.clear()
        for writer in writers:
            await writer.abort()
        inputs = list(self.inputs.values())
        self.inputs.clear()
        for source in inputs:
            await _close(source)
        spools = list(self.spools.values())
        self.spools.clear()
        for spool in spools:
            await spool.close()


async def _close(source: AsyncIterator[bytes]) -> None:
    close = getattr(source, "aclose", None)
    if close is not None:
        await close()


__all__ = ["StreamHost"]
