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

import logging
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from functools import partial

from mirage.commands.builtin.generic_bind.dispatch import caller_stream
from mirage.commands.builtin.utils.links import link_location
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    ranged_stream,
    resolve_source,
)
from mirage.commands.quote import quote_text
from mirage.context.session_context import current_caller
from mirage.errors.classify import classify
from mirage.errors.constants import FS_ERRORS, WALK_ERRORS
from mirage.errors.fs import eisdir, eloop, enoent, exdev, strerror_of
from mirage.errors.posix import posix_phrase
from mirage.errors.render import fs_error_line
from mirage.errors.types import FsCondition, OperationNotSupportedError
from mirage.io.async_line_iterator import SharedInput
from mirage.io.cooperative import CHUNK_SIZE, chunks
from mirage.io.spool import ByteSpool, spooled_pair
from mirage.io.stream import drain
from mirage.io.types import ByteSource, IOResult
from mirage.io.writer import ByteWriter
from mirage.io.yield_budget import YieldBudget
from mirage.rs.stream import Served, open_stream, serve_requests
from mirage.runtime.types import DispatchFn, ShellFn
from mirage.shell.bytes import byte_view, text_view
from mirage.shell.join import shell_join
from mirage.types import (
    LINK_TARGET_KEY,
    FileType,
    JsonValue,
    PathSpec,
    ReadStreamFn,
)
from mirage.utils.dates import stat_epoch
from mirage.utils.path import CycleError
from mirage.view.types import LinkView, MountView

logger = logging.getLogger(__name__)

STDIN_NAMES = frozenset({"-", "/dev/stdin"})


async def _spooled(spool: ByteSpool) -> AsyncIterator[bytes]:
    async with spool:
        async for chunk in spool.stream():
            yield chunk


def _failure(exc: BaseException) -> dict[str, JsonValue]:
    """A failed request's reply: the failure's words and the condition it
    names, when the vocabulary names one."""
    reply: dict[str, JsonValue] = {"error": byte_view(strerror_of(exc))}
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
        dash (bool): an operand ``-`` names stdin (see ``is_stdin``).
        command (str): The command a failed operand's line names, worded
            as ``fs_error_line`` words it, and that may create no file
            one of its operands names; empty leaves both to the stream.
        local (Callable[[PathSpec], bool] | None): Whether the mount
            serves an operand; None for every one, as it resolved them.
        links (LinkView | None): The workspace's links, which a readlink
            reads; None outside a workspace.
        mounts (MountView | None): Where the mounts meet, which a copy
            standing in for a rename does not cross.
        unbuffered (bool): The stream read no further into standard input
            than it used, so what it hands back the next command reads.
        sized (Callable[[PathSpec], Awaitable[int | None]] | None): An
            operand's length where a read may open past the bytes it
            skips (``file_size``); None opens every input at its start.
    """

    def __init__(
        self,
        operands: Sequence[PathSpec],
        stream: ReadStreamFn,
        stdin: ByteSource | None,
        dispatch: DispatchFn | None,
        cwd: PathSpec,
        shell: ShellFn | None = None,
        dash: bool = True,
        command: str = "",
        local: Callable[[PathSpec], bool] | None = None,
        links: LinkView | None = None,
        mounts: MountView | None = None,
        unbuffered: bool = False,
        sized: Callable[[PathSpec], Awaitable[int | None]] | None = None,
        chmod: Callable[[PathSpec, int], Awaitable[None]] | None = None,
    ) -> None:
        self.chmod = chmod
        self.operands = operands
        self.dash = dash
        self.command = command
        self.stream = stream
        self.stdin = resolve_source(stdin)
        self.shared = stdin if isinstance(stdin, SharedInput) else None
        self.left: tuple[bytes, int] = (b"", 0)
        self.dispatch = dispatch
        self.cwd = cwd
        self.shell = shell
        self.local = local
        self.links = links
        self.mounts = mounts
        self.unbuffered = unbuffered
        self.sized = sized
        self.lengths: dict[str, int | None] = {}
        self.caller = current_caller()
        self.inputs: dict[int, AsyncIterator[bytes]] = {}
        self.named: dict[int, PathSpec] = {}
        self.spools: dict[int, ByteSpool] = {}
        self.outputs: dict[str, ByteWriter] = {}
        self.errors = ByteSpool()

    async def stdin_view(self) -> AsyncIterator[bytes]:
        if self.shared is None:
            async for chunk in self.stdin:
                yield chunk
            return
        # Shared input arrives whole and is cut here, so what the stream
        # hands back takes the rest of its chunk with it.
        budget = YieldBudget()
        while (whole := await self.shared.lines.read_chunk()) is not None:
            for offset in range(0, len(whole), CHUNK_SIZE):
                await budget.run()
                self.left = (whole, offset + CHUNK_SIZE)
                yield whole[offset : offset + CHUNK_SIZE]
        self.left = (b"", 0)

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
        self,
        name: str,
        operand: int | None,
        file: bool = False,
        as_operand: bool = False,
    ) -> AsyncIterator[bytes]:
        """Open an input by name.

        Args:
            name (str): The file name, ``-`` or ``/dev/stdin`` for stdin.
            operand (int | None): The operand, from 1, the name came from.
            file (bool): a file a script names, which no spelling of
                stdin stands for.
            as_operand (bool): a name standing in for an operand (unzip's
                ``X.zip`` for ``X``), read as an operand is.
        """
        if file:
            return self.read_path(name)
        path = self._operand(name, operand)
        if path is None and as_operand:
            path = PathSpec.from_str_path(name, cwd=self.cwd.virtual)
        if path is not None:
            if is_stdin(path, self.dash):
                return self.stdin_view()
            return self.read_path(path, self.local is None or self.local(path))
        if name in STDIN_NAMES:
            return self.stdin_view()
        return self.read_path(name)

    def _operand(self, name: str, operand: int | None) -> PathSpec | None:
        """The operand a name is, when it still holds its spelling."""
        if operand is not None and 0 < operand <= len(self.operands):
            path = self.operands[operand - 1]
            if path.raw_path == name:
                return path
        return None

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
            if (spool := self.spools.pop(fd, None)) is not None:
                await spool.close()
            return Served({})
        if op == "write":
            return await self._write(request, data)
        if op in ("unlink", "mkdir", "stat", "rmdir"):
            return await self._path_op(op, str(request["path"]))
        if op == "chmod":
            return await self._chmod(
                str(request["path"]), int(str(request["mode"]))
            )
        if op == "readlink":
            return await self._readlink(str(request["path"]))
        if op in ("copy", "rename"):
            return await self._move(
                op, str(request["path"]), str(request["to"])
            )
        if op == "unread":
            self._unread(data)
            return Served({})
        if op == "fill" and isinstance(into := request.get("into"), int):
            return await self._fill(into, request)
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
            skip, size = request.get("skip"), request.get("size")
            if isinstance(skip, int) and isinstance(size, int):
                held = self.spools.get(fd)
                return Served(
                    {},
                    output=None if held is None else held.stream(skip, size),
                )
            spool = self.spools.pop(fd, None)
            return Served(
                {}, output=None if spool is None else _spooled(spool)
            )
        if op == "run":
            return await self._run(request)
        raise ValueError(f"unknown stream request: {op}")

    def _open(
        self, fd: int, request: Mapping[str, JsonValue]
    ) -> AsyncIterator[bytes] | None:
        """The input a read or a fill opens: an operand, a name, or a spool
        past its first ``skip`` bytes, where nothing spooled reads as
        empty."""
        path = request.get("path")
        spool = request.get("spool")
        if isinstance(spool, int):
            skip = request.get("skip")
            held = self.spools.get(spool)
            return (
                held.stream(skip if isinstance(skip, int) else 0)
                if held
                else None
            )
        if not isinstance(path, str):
            return None
        operand = request.get("operand")
        name = text_view(path)
        index = operand if isinstance(operand, int) else None
        if self.command and (named := self._operand(name, index)):
            self.named[fd] = named
        return self.open_input(
            name,
            index,
            request.get("file") is True,
            request.get("as_operand") is True,
        )

    async def _start(
        self, fd: int, request: Mapping[str, JsonValue]
    ) -> tuple[dict[str, JsonValue], AsyncIterator[bytes] | None]:
        """Open an input for a read. A range (``skip``, at most ``size``
        bytes) opens an operand past the bytes it skips where its length
        is known, and the reply says how far (``skipped``) and that length
        (``size``); any other input opens at its start."""
        path, skip, operand = (
            request.get(k) for k in ("path", "skip", "operand")
        )
        sized = self.sized
        if (
            sized is None
            or not isinstance(path, str)
            or not isinstance(skip, int)
            or not isinstance(operand, int)
        ):
            return {}, self._open(fd, request)
        named = self._operand(text_view(path), operand)
        if (
            named is None
            or is_stdin(named, self.dash)
            or (self.local is not None and not self.local(named))
        ):
            return {}, self._open(fd, request)
        if self.command:
            self.named[fd] = named
        if named.virtual not in self.lengths:
            self.lengths[named.virtual] = await sized(named)
        length = self.lengths[named.virtual]
        if length is None:
            return {}, self._open(fd, request)
        start = min(skip, length)
        size = request.get("size")
        end = min(length, start + size) if isinstance(size, int) else length
        opened: dict[str, JsonValue] = {"skipped": start, "size": length}
        if start >= end:
            # A skip past the whole file still opens it: one that refuses
            # fails here, and its bytes are not skipped.
            if start > 0:
                await drain(ranged_stream(self.stream, named, 0, 1))
            self.named.pop(fd, None)
            return opened, None
        return opened, ranged_stream(self.stream, named, start, end)

    def _failed(self, fd: int, exc: Exception) -> Served:
        """A failed input's reply, or raise what is not the file's own: the
        failure's words, and the line the command words for an operand."""
        if not isinstance(exc, FS_ERRORS) and classify(exc) is None:
            raise exc
        reply = _failure(exc)
        if (named := self.named.pop(fd, None)) is not None:
            reply["line"] = byte_view(fs_error_line(self.command, named, exc))
        return Served(reply)

    async def _fill(
        self, into: int, request: Mapping[str, JsonValue]
    ) -> Served:
        """Read an input whole into spool ``into`` and answer its length."""
        spool = self.spools.setdefault(into, ByteSpool())
        source = self._open(into, request)
        try:
            await spool.fill(source if source is not None else b"")
        except Exception as exc:
            return self._failed(into, exc)
        self.named.pop(into, None)
        return Served({"size": spool.size})

    async def _read(self, fd: int, request: Mapping[str, JsonValue]) -> Served:
        spool, skip, size = (request.get(k) for k in ("spool", "skip", "size"))
        if isinstance(spool, int) and isinstance(size, int):
            # A window comes whole, and nothing stays open.
            held = self.spools.get(spool)
            offset = skip if isinstance(skip, int) else 0
            if held is None or offset >= held.size:
                return Served({})
            return Served(
                {}, await held.read(offset, min(size, held.size - offset))
            )
        source = self.inputs.get(fd)
        opened: dict[str, JsonValue] = {}
        if source is None:
            try:
                opened, source = await self._start(fd, request)
            except Exception as exc:
                return self._failed(fd, exc)
            if source is not None:
                self.inputs[fd] = source
        if source is None:
            return Served({**opened, "end": True})
        least = request.get("least")
        ended = False
        try:
            chunk = await anext(source, None)
            # A file read whole gathers chunks to `least` bytes a reply, the
            # last of them sent with the end of the input.
            if chunk is not None and isinstance(least, int):
                parts, size = [chunk], len(chunk)
                while size < least:
                    if (more := await anext(source, None)) is None:
                        ended = True
                        break
                    parts.append(more)
                    size += len(more)
                chunk = b"".join(parts)
        except Exception as exc:
            del self.inputs[fd]
            return self._failed(fd, exc)
        if chunk is None or ended:
            del self.inputs[fd]
            self.named.pop(fd, None)
            return Served({**opened, "end": True}, bytes(chunk or b""))
        return Served(opened, bytes(chunk))

    async def _replace(
        self, path: PathSpec, atomic: bool, source: ByteSource
    ) -> None:
        assert self.dispatch is not None
        await self.dispatch("write", path, data=source, atomic=atomic)

    async def _chmod(self, name: str, mode: int) -> Served:
        """Give a path a mode, through the workspace's attribute overlay."""
        if self.chmod is None:
            return Served({"fatal": "file output requires a workspace"})
        path = PathSpec.from_str_path(text_view(name), cwd=self.cwd.virtual)
        try:
            await self.chmod(path, mode)
        except WALK_ERRORS as exc:
            return Served(_failure(exc))
        return Served({})

    async def _path_op(self, op: str, name: str) -> Served:
        """Unlink, make (one level) or stat a path; a stat answers what
        stands there, ``dir`` or ``file``, or why it found nothing."""
        if self.dispatch is None:
            return Served({"fatal": "file output requires a workspace"})
        path = PathSpec.from_str_path(text_view(name), cwd=self.cwd.virtual)
        try:
            found, _ = await self.dispatch(op, path)
        except WALK_ERRORS as exc:
            return Served(_failure(exc))
        if op != "stat" or found is None:
            return Served({})
        kind = "dir" if found.type == FileType.DIRECTORY else "file"
        mtime = stat_epoch(found.modified)
        return Served({"kind": kind, "mtime": mtime})

    def _where(self, path: PathSpec) -> str:
        """Where a name stands as lstat reaches it: every link above its
        final name followed, the name itself kept."""
        if self.links is None:
            return path.virtual
        try:
            return link_location(self.links, path.virtual)
        except CycleError:
            raise eloop(path) from None

    async def _readlink(self, name: str) -> Served:
        """What a link holds, or that the name is no link; a name nothing
        stands at, or a link the rules refuse, answers why. The name itself
        is never followed, the links above it are."""
        if self.dispatch is None:
            return Served({"fatal": "file output requires a workspace"})
        path = PathSpec.from_str_path(text_view(name), cwd=self.cwd.virtual)
        try:
            where = self._where(path)
            link = None if self.links is None else self.links.stat_at(where)
            target = None if link is None else link.extra.get(LINK_TARGET_KEY)
            if link is not None and isinstance(target, str):
                await self.dispatch("readlink", path)
                mtime = stat_epoch(link.modified)
                return Served({"target": byte_view(target), "mtime": mtime})
            found, _ = await self.dispatch("stat", path)
            if found is None:
                raise enoent(path)
        except WALK_ERRORS as exc:
            return Served(_failure(exc))
        return Served({})

    async def _move(self, op: str, source: str, target: str) -> Served:
        """Move a name, a link as itself, or keep a copy of a file as a
        rename would put it there (``_keep``)."""
        if self.dispatch is None:
            return Served({"fatal": "file output requires a workspace"})
        src = PathSpec.from_str_path(text_view(source), cwd=self.cwd.virtual)
        dst = PathSpec.from_str_path(text_view(target), cwd=self.cwd.virtual)
        try:
            if op == "rename":
                await self.dispatch("rename", src, dst=dst)
            else:
                await self._keep(src, dst)
        except WALK_ERRORS as exc:
            return Served(_failure(exc))
        return Served({})

    async def _keep(self, src: PathSpec, dst: PathSpec) -> None:
        """Keep file ``src`` under ``dst`` as rename(2) would move it
        there: in place of a file or link standing at ``dst``, refused onto
        a directory or another mount, its permission bits kept, and not at
        all where ``dst`` names ``src`` itself. The store copies the bytes
        where it can; otherwise they stream through."""
        assert self.dispatch is not None
        if self.mounts is not None and self.mounts.root_of(
            src.virtual
        ) != self.mounts.root_of(dst.virtual):
            raise exdev(src)
        if self._where(src) == self._where(dst):
            return
        try:
            standing, _ = await self.dispatch("stat", dst, nofollow=True)
        except FileNotFoundError as exc:
            logger.debug("no file stands at %s: %s", dst.virtual, exc)
            standing = None
        if standing is not None:
            if standing.type == FileType.DIRECTORY:
                raise eisdir(dst)
            await self.dispatch("unlink", dst)
        original, _ = await self.dispatch("stat", src)
        try:
            await self.dispatch("copy", src, dst=dst)
        except OperationNotSupportedError as exc:
            logger.debug("%s copies through mirage: %s", src.virtual, exc)
            data, _ = await self.dispatch("read", src)
            await self.dispatch("write", dst, data=data)
        mode = None if original is None else original.mode
        if mode is None:
            return
        try:
            await self.dispatch("setattr", dst, mode=mode)
        except OperationNotSupportedError as exc:
            logger.debug("%s keeps no permission bits: %s", dst.virtual, exc)

    def _unread(self, data: bytes) -> None:
        """Give standard input back what the stream read of it and left,
        so the next command reads on from there: -u read no further than
        it used, and a file's offset goes back to where the stream
        stopped."""
        if self.shared is None or not (
            self.unbuffered or self.shared.seekable
        ):
            return
        chunk, offset = self.left
        self.left = (b"", 0)
        if rest := data + chunk[offset:]:
            self.shared.lines.unread(rest)

    async def _write(
        self, request: Mapping[str, JsonValue], data: bytes
    ) -> Served:
        """Write to a file: ``append`` adds to it, otherwise it is emptied
        first, every held write committed before; ``atomic`` replaces it
        whole, once flushed, with what this and later writes carry, and
        ``create`` writes it whole as they carry it, ``whole`` from this
        write's bytes alone; ``spool`` writes that
        spool's bytes past its first ``skip`` and drops it, or, with
        ``size``, that many of them and keeps it, with ``create`` the
        file whole from them."""
        if self.dispatch is None:
            return Served({"fatal": "file output requires a workspace"})
        name = str(request["path"])
        path = PathSpec.from_str_path(text_view(name), cwd=self.cwd.virtual)
        # GNU split refuses an output that is its input before it empties
        # it; csplit is refused alike, where GNU's empties its input.
        if request.get("create") and self.command:
            if any(path.virtual == spec.virtual for spec in self.operands):
                line = f"'{quote_text(text_view(name))}' would overwrite input"
                refused = byte_view(f"{self.command}: {line}; aborting\n")
                return Served({"error": refused, "line": refused})
        if request.get("whole"):
            try:
                await self.dispatch("write", path, data=data)
            except WALK_ERRORS as exc:
                return Served(_failure(exc))
            return Served({})
        spool_fd = request.get("spool")
        size, skip = request.get("size"), request.get("skip")
        offset = skip if isinstance(skip, int) else 0
        window_size = size if isinstance(size, int) else None
        keep = window_size is not None
        if request.get("create") and keep and isinstance(spool_fd, int):
            # A window of a spool is the whole file, written as one call.
            whole = self.spools.get(spool_fd)
            window = (
                b"" if whole is None else whole.stream(offset, window_size)
            )
            try:
                await self.dispatch("write", path, data=window)
            except WALK_ERRORS as exc:
                return Served(_failure(exc))
            return Served({})
        spool = (
            (self.spools.get if keep else self.spools.pop)(spool_fd, None)
            if isinstance(spool_fd, int)
            else None
        )
        try:
            atomic = request.get("atomic") is True
            if atomic or request.get("create"):
                if (held := self.outputs.pop(name, None)) is not None:
                    await held.abort()
                # The replacement opens now, so a refusal is reported
                # before the stream reads on.
                replacement = ByteWriter(partial(self._replace, path, atomic))
                try:
                    await replacement.opened()
                except BaseException:
                    await replacement.abort()
                    raise
                self.outputs[name] = replacement
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
                async for chunk in spool.stream(offset, window_size):
                    await writer.write(chunk)
        except WALK_ERRORS as exc:
            return Served(_failure(exc))
        finally:
            if spool is not None and not keep:
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


async def hosted_stream(
    kind: str, config: Mapping[str, JsonValue], host: StreamHost, io: IOResult
) -> AsyncIterator[bytes]:
    """Run a stream that reaches files through ``host``, yielding its
    output as it settles; output closed early still lets what it wrote to
    its files land. The engine opens on the first pull, so output closed
    before one holds none.

    Args:
        kind (str): the mirage-rs stream.
        config (Mapping[str, JsonValue]): its configuration.
        host (StreamHost): serves the inputs and files it reaches.
        io (IOResult): receives the exit status and stderr.
    """
    engine = open_stream(kind, config)
    try:
        async with aclosing(serve_requests(engine, host)) as output:
            async for chunk in output:
                yield chunk
    except GeneratorExit:
        if engine.cancel():
            await drain(serve_requests(engine, host))
        raise
    finally:
        io.exit_code = engine.status()
        io.stderr = await host.errors.output()
        await host.close()


async def _close(source: AsyncIterator[bytes]) -> None:
    close = getattr(source, "aclose", None)
    if close is not None:
        await close()


__all__ = ["StreamHost", "hosted_stream"]
