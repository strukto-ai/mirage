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
import base64
import binascii
import concurrent.futures
import json
import logging
import os
import posixpath
import shlex
import stat
from collections import deque
from collections.abc import Awaitable, Callable, Coroutine
from typing import Any, TypeVar
from urllib.parse import quote, unquote, urlsplit

import asyncssh

from mirage import Workspace
from mirage.errors import FsCondition, classify
from mirage.errors.classify import failure_text
from mirage.errors.fs import eexist, enoent
from mirage.errors.posix import posix_errno, posix_phrase
from mirage.errors.types import NoMountError
from mirage.io.types import ByteSource
from mirage.mount.core import MountCore
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry
from mirage.server.rpc.constants import (
    RPC_INTERNAL_ERROR,
    RPC_INVALID_PARAMS,
    RPC_INVALID_REQUEST,
    RPC_METHOD_NOT_FOUND,
    RPC_NOT_FOUND,
    RPC_PARSE_ERROR,
)
from mirage.server.ssh import constants
from mirage.server.ssh.errors import CodexRPCError
from mirage.server.ssh.session import open_login
from mirage.server.ssh.stream import (
    ChannelInput,
    Mark,
    Send,
    decode,
    deliver,
    encode,
)
from mirage.types import JsonValue
from mirage.utils.abort import MirageAbortError

logger = logging.getLogger(__name__)

T = TypeVar("T")

Message = dict[str, JsonValue]
Handler = Callable[[Message], Awaitable[JsonValue]]

FILE_SCHEME = "file://"
NS_PER_MS = 1_000_000
MISSING = (FileNotFoundError, NotADirectoryError, NoMountError)


def to_path(uri: JsonValue) -> str:
    """A ``file:`` URI as a workspace path: absolute and normalized.

    Args:
        uri (JsonValue): the URI Codex sent.

    Raises:
        CodexRPCError: not an absolute ``file:`` URI.
    """
    if not isinstance(uri, str):
        raise CodexRPCError(RPC_INVALID_PARAMS, "a path must be a file: URI")
    parts = urlsplit(uri)
    if parts.scheme != "file" or not parts.path.startswith("/"):
        raise CodexRPCError(RPC_INVALID_PARAMS, f"invalid URI: {uri}")
    return posixpath.normpath("/" + unquote(parts.path).lstrip("/"))


def to_uri(path: str) -> str:
    return FILE_SCHEME + quote(path)


def arg(
    params: Message, name: str, kind: type[T], default: T | None = None
) -> T:
    """One request field, of the type the protocol gives it.

    Args:
        params (Message): the request's params.
        name (str): the field.
        kind (type[T]): its type.
        default (T | None): its value when absent or null; None makes
            the field required.

    Raises:
        CodexRPCError: the field is missing or of another type.
    """
    given = params.get(name)
    value = default if given is None else given
    if value is None:
        raise CodexRPCError(RPC_INVALID_PARAMS, f"missing field `{name}`")
    if not isinstance(value, kind) or (
        kind is int and isinstance(value, bool)
    ):
        raise CodexRPCError(
            RPC_INVALID_PARAMS, f"invalid type for field `{name}`"
        )
    return value


def strings(value: JsonValue, name: str) -> dict[str, str]:
    """A ``{name: value}`` map of strings, as ``env`` and ``set`` carry.

    Args:
        value (JsonValue): the field's value; None is an empty map.
        name (str): the field, for the error.
    """
    if value is None:
        return {}
    if not isinstance(value, dict) or not all(
        isinstance(v, str) for v in value.values()
    ):
        raise CodexRPCError(
            RPC_INVALID_PARAMS, f"`{name}` must map names to strings"
        )
    return {k: v for k, v in value.items() if isinstance(v, str)}


def process_env(params: Message) -> dict[str, str]:
    """The variables a process sets over its session's environment.

    The exec-server builds a process's environment from its own under
    ``envPolicy`` and lays ``env`` over it; here the session's
    environment is the server's own, so ``envPolicy.set`` and ``env``
    are laid over it, ``env`` last.

    Args:
        params (Message): the ``process/start`` params.
    """
    policy = params.get("envPolicy")
    base = (
        strings(policy.get("set"), "envPolicy.set")
        if isinstance(policy, dict)
        else {}
    )
    return {**base, **strings(params.get("env"), "env")}


def argv_line(argv: list[str]) -> str:
    """The shell line an argv runs as.

    A shell's ``-c`` script (``bash -lc 'ls'``, what Codex sends for
    every command) runs as the line itself; any other argv is quoted
    word by word.

    Args:
        argv (list[str]): the program and its arguments.
    """
    if (
        len(argv) == 3
        and posixpath.basename(argv[0]) in constants.CODEX_SHELLS
        and argv[1].startswith("-")
        and "c" in argv[1]
    ):
        return argv[2]
    return shlex.join(argv)


def rpc_error(err: Exception) -> CodexRPCError:
    """The JSON-RPC error for a failed operation: a missing path is
    Codex's not-found, anything else an internal error, worded as GNU
    words the condition.

    Args:
        err (Exception): what the operation raised.
    """
    condition = classify(err)
    if condition is None and not isinstance(err, OSError):
        logger.warning("codex: unclassified error: %r", err)
    rpc = (
        RPC_NOT_FOUND
        if condition is FsCondition.ENOENT
        else RPC_INTERNAL_ERROR
    )
    return CodexRPCError(rpc, failure_text(err))


def not_a_file(path: str) -> CodexRPCError:
    return CodexRPCError(RPC_INVALID_REQUEST, f"path `{path}` is not a file")


async def lookup(core: MountCore, path: str) -> dict[str, Any] | None:
    try:
        return await core.getattr(path)
    except MISSING:
        return None


async def followed(core: MountCore, path: str) -> dict[str, Any]:
    return await core.getattr(path, follow=True)


async def metadata(core: MountCore, path: str) -> Message:
    """``fs/getMetadata``: what the path points at, and whether it is a
    link.

    Args:
        core (MountCore): the channel's mount core.
        path (str): the path.
    """
    own = await core.getattr(path)
    link = stat.S_ISLNK(own["st_mode"])
    st = await followed(core, path) if link else own
    return {
        "isDirectory": stat.S_ISDIR(st["st_mode"]),
        "isFile": stat.S_ISREG(st["st_mode"]),
        "isSymlink": link,
        "size": st["st_size"],
        "createdAtMs": st["st_ctime"] // NS_PER_MS,
        "modifiedAtMs": st["st_mtime"] // NS_PER_MS,
    }


async def open_file(core: MountCore, path: str) -> int:
    if stat.S_ISDIR((await followed(core, path))["st_mode"]):
        raise not_a_file(path)
    return await core.open(path)


async def read_file(core: MountCore, path: str) -> bytes:
    fh = await open_file(core, path)
    try:
        parts = []
        offset = 0
        while chunk := await core.read(
            path, constants.CODEX_READ_SIZE, offset, fh
        ):
            parts.append(chunk)
            offset += len(chunk)
        return b"".join(parts)
    finally:
        await core.release(fh)


async def write_file(core: MountCore, path: str, data: bytes) -> None:
    """``fs/writeFile``: create or replace the file; its directory must
    exist.

    Args:
        core (MountCore): the channel's mount core.
        path (str): the file.
        data (bytes): its new content.
    """
    parent = await lookup(core, posixpath.dirname(path))
    if parent is None:
        raise enoent(path)
    fh = (
        await core.open(path, os.O_TRUNC)
        if await lookup(core, path)
        else await core.create(path)
    )
    try:
        if data:
            await core.write(path, data, 0, fh)
        await core.flush(path, fh)
    finally:
        await core.release(fh)


async def make_directory(core: MountCore, path: str) -> None:
    if await lookup(core, path) is not None:
        raise eexist(path)
    if await lookup(core, posixpath.dirname(path)) is None:
        raise enoent(path)
    await core.mkdir(path)


async def children(core: MountCore, path: str) -> list[str]:
    return [n for n in await core.readdir(path) if n not in (".", "..")]


async def directory(core: MountCore, path: str) -> list[JsonValue]:
    """``fs/readDirectory``: each entry with the kind it points at.

    An entry that vanishes between the listing and its stat is left
    out, as SFTP's listing leaves it out.

    Args:
        core (MountCore): the channel's mount core.
        path (str): the directory.
    """
    entries: list[JsonValue] = []
    for name in await children(core, path):
        child = posixpath.join(path, name)
        try:
            st = await followed(core, child)
        except MISSING as exc:
            logger.debug("codex: %s vanished while listing: %r", child, exc)
            continue
        entries.append(
            {
                "fileName": name,
                "isDirectory": stat.S_ISDIR(st["st_mode"]),
                "isFile": stat.S_ISREG(st["st_mode"]),
            }
        )
    return entries


async def walk_kind(core: MountCore, path: str, follow: bool) -> str | None:
    """What a walk reports an entry as, or None to leave it out: a
    link counts only when followed, and only as a directory.

    Args:
        core (MountCore): the channel's mount core.
        path (str): the entry.
        follow (bool): ``followDirectorySymlinks``.
    """
    mode = (await core.getattr(path))["st_mode"]
    if stat.S_ISLNK(mode):
        if not follow or not stat.S_ISDIR(
            (await followed(core, path))["st_mode"]
        ):
            return None
        return "directory"
    return "directory" if stat.S_ISDIR(mode) else "file"


async def walk(core: MountCore, root: str, options: Message) -> Message:
    """``fs/walk``: the tree breadth first, each directory's entries in
    name order, within the request's limits.

    Depth 0 is the root's own entries. A directory that cannot be read
    is reported under ``errors`` and the walk goes on.

    Args:
        core (MountCore): the channel's mount core.
        root (str): where the walk starts.
        options (Message): ``maxDepth``, ``maxDirectories``,
            ``maxEntries`` and ``followDirectorySymlinks``.
    """
    max_depth = arg(options, "maxDepth", int)
    max_directories = arg(options, "maxDirectories", int)
    max_entries = arg(options, "maxEntries", int)
    follow = arg(options, "followDirectorySymlinks", bool)
    if max_directories <= 0 or max_entries <= 0:
        raise CodexRPCError(
            RPC_INVALID_REQUEST,
            "filesystem walk limits must be greater than zero",
        )
    entries: list[JsonValue] = []
    errors: list[JsonValue] = []
    result: Message = {"entries": entries, "errors": errors}
    if not stat.S_ISDIR((await followed(core, root))["st_mode"]):
        return {**result, "truncated": False}
    pending = deque([(root, 0)])
    read = 0
    while pending:
        if read >= max_directories:
            return {**result, "truncated": True}
        path, depth = pending.popleft()
        read += 1
        try:
            names = sorted(await children(core, path))
        except Exception as err:
            errors.append(
                {"path": to_uri(path), "message": str(rpc_error(err))}
            )
            continue
        for name in names:
            child = posixpath.join(path, name)
            kind = await walk_kind(core, child, follow)
            if kind is None:
                continue
            if len(entries) >= max_entries:
                return {**result, "truncated": True}
            entries.append({"path": to_uri(child), "kind": kind})
            if kind == "directory" and depth < max_depth:
                pending.append((child, depth + 1))
    return {**result, "truncated": False}


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def unb64(text: str, name: str) -> bytes:
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise CodexRPCError(
            RPC_INVALID_PARAMS, f"`{name}` is not base64: {exc}"
        ) from exc


class ProcessInput:
    """What Codex writes to a process, as the line's stdin.

    Writes arrive on the channel's loop and queue on the workspace's,
    where the line reads them; closing ends the stream.

    Args:
        loop (asyncio.AbstractEventLoop): the workspace's loop.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        self.closed = False

    def write(self, data: bytes) -> None:
        self._loop.call_soon_threadsafe(self._queue.put_nowait, data)

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            self._loop.call_soon_threadsafe(self._queue.put_nowait, b"")

    def __aiter__(self) -> "ProcessInput":
        return self

    async def __anext__(self) -> bytes:
        data = await self._queue.get()
        if not data:
            raise StopAsyncIteration
        return data


class CodexProcess:
    """One started process: its recent output and how it ended.

    Output is kept for ``process/read`` up to ``CODEX_RETAINED_OUTPUT``
    bytes, the oldest chunks dropped first; notifications carry all of
    it.

    Args:
        process_id (str): Codex's id for it.
        tty (bool): whether its output reads as one terminal stream.
        stdin (ProcessInput | None): its input, when Codex may write.
    """

    def __init__(
        self, process_id: str, tty: bool, stdin: ProcessInput | None
    ) -> None:
        self.process_id = process_id
        self.tty = tty
        self.stdin = stdin
        self.chunks: deque[tuple[int, int, Message]] = deque()
        self.retained = 0
        self.seq = 0
        self.exit_code: int | None = None
        self.closed = False
        self.stop_code: int | None = None
        self.changed = asyncio.Event()
        self.future: concurrent.futures.Future[int] | None = None
        self.task: asyncio.Task[None] | None = None

    def next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def keep(self, seq: int, size: int, chunk: Message) -> None:
        """Keep a chunk for ``process/read``, dropping the oldest past
        the bound.

        Args:
            seq (int): the chunk's sequence number.
            size (int): its byte length.
            chunk (Message): the chunk as ``process/read`` returns it.
        """
        self.chunks.append((seq, size, chunk))
        self.retained += size
        while self.retained > constants.CODEX_RETAINED_OUTPUT and self.chunks:
            _, dropped, _ = self.chunks.popleft()
            self.retained -= dropped


async def run_process(
    ws: Workspace,
    session_id: str,
    line: str,
    cwd: str,
    env: dict[str, str],
    stdin: ByteSource,
    send: Send,
) -> int:
    """Run one process's line as the session, streaming its output as
    the line produces it.

    Runs on the workspace's loop. The status is read once the output
    has ended, because a streaming command settles it only then.

    Args:
        ws (Workspace): the workspace.
        session_id (str): the channel's session.
        line (str): the shell line.
        cwd (str): where it runs.
        env (dict[str, str]): variables it sets for itself.
        stdin (ByteSource): its input; empty, like ``/dev/null``, when
            Codex does not pipe one.
        send (Send): where output goes.

    Returns:
        int: the line's exit status.
    """
    async with await ws.shell(
        line,
        session_id=session_id,
        stdin=stdin,
        agent_id=constants.CODEX_AGENT_ID,
        cwd=cwd,
        env=env or None,
        stream=True,
    ) as execution:
        io = await deliver(execution, send)
    return io.exit_code


async def run_quiet(
    ws: Workspace, session_id: str, line: str
) -> tuple[int, str]:
    """Run an unrecorded line as the session and drain it.

    Runs on the workspace's loop; the status is read once both streams
    are drained, as ``run_process`` reads it.

    Args:
        ws (Workspace): the workspace.
        session_id (str): the channel's session.
        line (str): the shell line.

    Returns:
        tuple[int, str]: the exit status and stderr.
    """
    io = await ws.shell(line, session_id=session_id, record=False)
    await io.materialize_stdout()
    err = await io.stderr_str()
    return io.exit_code, err


class CodexChannel:
    """One codex-exec channel: Codex's exec-server over one session.

    Codex runs its agent where it is and sends each tool call here: a
    process runs as a line in the channel's session, and a file call
    lands on the MountCore SFTP uses, so both see the tree, modes and
    policies a shell in that session sees. Requests are answered one
    at a time, in order, as the exec-server answers them by default,
    except ``process/read``, which may wait for output and so runs
    beside them. A process runs on in the background and reports
    through notifications; once it has closed, ``process/terminate``
    forgets it, as Codex sends after every command.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        entry (WorkspaceEntry): the workspace this channel serves.
        session_id (str): the session the channel runs as.
        process (asyncssh.SSHServerProcess[str]): the channel's process.
    """

    def __init__(
        self,
        registry: WorkspaceRegistry,
        entry: WorkspaceEntry,
        session_id: str,
        process: asyncssh.SSHServerProcess[str],
    ) -> None:
        ws = entry.runner.ws
        self._registry = registry
        self._entry = entry
        self._session_id = session_id
        self._process = process
        self._input = ChannelInput(
            process, max_line=constants.CODEX_MAX_MESSAGE
        )
        self._core = MountCore(ws.vfs, session=ws.get_session(session_id))
        self._processes: dict[str, CodexProcess] = {}
        self._handles: dict[str, tuple[str, int]] = {}
        self._starts: list[tuple[CodexProcess, str, str, dict[str, str]]] = []
        self._reads: set[asyncio.Task[None]] = set()
        self._methods: dict[str, Handler] = {
            "initialize": self._initialize,
            "environment/info": self._environment_info,
            "process/start": self._process_start,
            "process/read": self._process_read,
            "process/write": self._process_write,
            "process/signal": self._process_signal,
            "process/terminate": self._process_terminate,
            "fs/getMetadata": self._get_metadata,
            "fs/canonicalize": self._canonicalize,
            "fs/readFile": self._read_file,
            "fs/writeFile": self._write_file,
            "fs/createDirectory": self._create_directory,
            "fs/readDirectory": self._read_directory,
            "fs/walk": self._walk,
            "fs/remove": self._remove,
            "fs/copy": self._copy,
            "fs/open": self._open,
            "fs/readBlock": self._read_block,
            "fs/close": self._close,
        }

    def _live(self) -> bool:
        wid = self._entry.id
        return wid in self._registry and self._registry.get(wid) is self._entry

    async def serve(self) -> int:
        """Answer requests until the channel's input ends.

        Returns:
            int: the exit status to report to the client.
        """
        self._input.start()
        try:
            while True:
                item = await self._input.readline()
                if item is Mark.LIMIT:
                    self._process.stderr.write(
                        "mirage: codex-exec message too long\n"
                    )
                    return 1
                if item is Mark.EOF:
                    return 0
                if isinstance(item, bytes):
                    await self._receive(decode(item))
        finally:
            await self._shutdown()

    async def _shutdown(self) -> None:
        for read in self._reads:
            read.cancel()
        if self._reads:
            await asyncio.wait(self._reads)
        for proc in self._processes.values():
            if proc.future is not None:
                proc.future.cancel()
        tasks = [p.task for p in self._processes.values() if p.task]
        if tasks:
            await asyncio.wait(tasks)
        for _, fh in self._handles.values():
            await self._release(fh)
        self._handles.clear()
        await self._input.close()
        if self._live():
            runner = self._entry.runner
            await runner.call(runner.ws.close_session(self._session_id))

    async def _send(self, message: Message) -> None:
        stdout = self._process.stdout
        try:
            stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
            await stdout.drain()
        except (asyncssh.Error, OSError) as exc:
            logger.debug("codex: channel closed before a message: %r", exc)

    async def _receive(self, text: str) -> None:
        if not text.strip():
            return
        try:
            message = json.loads(text)
        except ValueError as exc:
            await self._send(
                {
                    "id": None,
                    "error": {
                        "code": RPC_PARSE_ERROR,
                        "message": str(exc),
                    },
                }
            )
            return
        if not isinstance(message, dict) or not isinstance(
            message.get("method"), str
        ):
            logger.debug("codex: ignoring a message that is not a request")
            return
        if "id" not in message:
            return
        if message["method"] == "process/read":
            # A read may wait for output; stdin and signals sent behind it
            # must not wait with it.
            read = asyncio.create_task(
                self._answer(
                    message["id"], message["method"], message.get("params")
                )
            )
            self._reads.add(read)
            read.add_done_callback(self._reads.discard)
            return
        await self._answer(
            message["id"], message["method"], message.get("params")
        )
        starts, self._starts = self._starts, []
        for proc, line, cwd, env in starts:
            self._launch(proc, line, cwd, env)

    async def _answer(
        self, request_id: JsonValue, method: str, params: JsonValue
    ) -> None:
        try:
            result = await self._dispatch(method, params)
        except CodexRPCError as exc:
            await self._send(
                {
                    "id": request_id,
                    "error": {"code": exc.code, "message": str(exc)},
                }
            )
            return
        await self._send({"id": request_id, "result": result})

    async def _dispatch(self, method: str, params: JsonValue) -> JsonValue:
        handler = self._methods.get(method)
        if handler is None:
            raise CodexRPCError(
                RPC_METHOD_NOT_FOUND,
                f"unsupported method `{method}`",
            )
        if params is None:
            params = {}
        if not isinstance(params, dict):
            raise CodexRPCError(RPC_INVALID_PARAMS, "params must be an object")
        try:
            return await handler(params)
        except CodexRPCError:
            raise
        except Exception as err:
            raise rpc_error(err) from err

    async def _fs(
        self, op: Callable[[MountCore], Coroutine[Any, Any, T]]
    ) -> T:
        return await self._entry.runner.call(op(self._core))

    async def _release(self, fh: int) -> None:
        await self._fs(lambda core: core.release(fh))

    async def _line(self, line: str) -> None:
        """Run a file operation's shell line, unrecorded, as the session.

        Args:
            line (str): the line.

        Raises:
            CodexRPCError: the line failed; its stderr is the message.
        """
        runner = self._entry.runner
        code, err = await runner.call(
            run_quiet(runner.ws, self._session_id, line)
        )
        if code != 0:
            raise CodexRPCError(
                RPC_INTERNAL_ERROR, err.strip() or f"exit {code}"
            )

    async def _initialize(self, params: Message) -> JsonValue:
        return {"sessionId": self._session_id}

    async def _environment_info(self, params: Message) -> JsonValue:
        cwd = self._entry.runner.ws.get_session(self._session_id).cwd
        return {
            "shell": {
                "name": constants.CODEX_SHELL_NAME,
                "path": constants.CODEX_SHELL_PATH,
            },
            "cwd": to_uri(cwd),
            "capabilities": {},
        }

    async def _process_start(self, params: Message) -> JsonValue:
        process_id = arg(params, "processId", str)
        argv = arg(params, "argv", list)
        if not argv or not all(isinstance(a, str) for a in argv):
            raise CodexRPCError(
                RPC_INVALID_PARAMS,
                "`argv` must be a non-empty list of strings",
            )
        cwd = to_path(arg(params, "cwd", str))
        env = process_env(params)
        tty = arg(params, "tty", bool, False)
        pipe = arg(params, "pipeStdin", bool, False)
        if process_id in self._processes:
            raise CodexRPCError(
                RPC_INVALID_REQUEST,
                f"process {process_id} already exists",
            )
        stdin = ProcessInput(self._entry.runner.loop) if tty or pipe else None
        proc = CodexProcess(process_id, tty, stdin)
        self._processes[process_id] = proc
        self._starts.append(
            (proc, argv_line([str(a) for a in argv]), cwd, env)
        )
        return {"processId": process_id, "sandboxType": "none"}

    def _launch(
        self, proc: CodexProcess, line: str, cwd: str, env: dict[str, str]
    ) -> None:
        runner = self._entry.runner
        loop = asyncio.get_running_loop()

        async def send(data: bytes, stderr: bool) -> None:
            await asyncio.wrap_future(
                asyncio.run_coroutine_threadsafe(
                    self._output(proc, data, stderr), loop
                )
            )

        stdin: ByteSource = b"" if proc.stdin is None else proc.stdin
        proc.future = asyncio.run_coroutine_threadsafe(
            run_process(
                runner.ws, self._session_id, line, cwd, env, stdin, send
            ),
            runner.loop,
        )
        proc.task = asyncio.create_task(self._finish(proc))

    async def _output(
        self, proc: CodexProcess, data: bytes, stderr: bool
    ) -> None:
        stream = "pty" if proc.tty else "stderr" if stderr else "stdout"
        seq = proc.next_seq()
        chunk: Message = {"seq": seq, "stream": stream, "chunk": b64(data)}
        proc.keep(seq, len(data), chunk)
        proc.changed.set()
        await self._send(
            {
                "method": "process/output",
                "params": {"processId": proc.process_id, **chunk},
            }
        )

    async def _finish(self, proc: CodexProcess) -> None:
        if proc.future is None:
            return
        try:
            code = await asyncio.wrap_future(proc.future)
        except (asyncio.CancelledError, MirageAbortError):
            task = asyncio.current_task()
            if task is not None and task.cancelling():
                raise
            code = proc.stop_code or constants.CODEX_INTERRUPTED
        except Exception as exc:
            logger.warning(
                "codex: process failed on %s: %r", self._entry.id, exc
            )
            await self._output(proc, encode(f"mirage: {exc}\n"), True)
            code = 1
        proc.exit_code = code
        if proc.stdin is not None:
            proc.stdin.close()
        await self._send(
            {
                "method": "process/exited",
                "params": {
                    "processId": proc.process_id,
                    "seq": proc.next_seq(),
                    "exitCode": code,
                    "sandboxDenied": False,
                },
            }
        )
        proc.closed = True
        proc.changed.set()
        await self._send(
            {
                "method": "process/closed",
                "params": {
                    "processId": proc.process_id,
                    "seq": proc.next_seq(),
                },
            }
        )
        if proc.stop_code == constants.CODEX_TERMINATED:
            self._processes.pop(proc.process_id, None)

    def _known(self, params: Message) -> CodexProcess:
        process_id = arg(params, "processId", str)
        proc = self._processes.get(process_id)
        if proc is None:
            raise CodexRPCError(
                RPC_INVALID_REQUEST,
                f"unknown process id {process_id}",
            )
        return proc

    def _stop(self, proc: CodexProcess, code: int) -> bool:
        if proc.exit_code is not None or proc.future is None:
            return False
        if proc.stop_code is None:
            proc.stop_code = code
            proc.future.cancel()
        return True

    async def _process_read(self, params: Message) -> JsonValue:
        proc = self._known(params)
        after = arg(params, "afterSeq", int, 0)
        wait_ms = arg(params, "waitMs", int, 0)
        fresh: list[JsonValue] = [
            c for seq, _, c in proc.chunks if seq > after
        ]
        if not fresh and not proc.closed and wait_ms > 0:
            proc.changed.clear()
            try:
                await asyncio.wait_for(proc.changed.wait(), wait_ms / 1000)
            except TimeoutError:
                logger.debug(
                    "codex: %s had nothing new in %d ms",
                    proc.process_id,
                    wait_ms,
                )
            fresh = [c for seq, _, c in proc.chunks if seq > after]
        return {
            "chunks": fresh,
            "nextSeq": proc.seq + 1,
            "exited": proc.exit_code is not None,
            "exitCode": proc.exit_code,
            "closed": proc.closed,
            "failure": None,
            "sandboxDenied": False,
        }

    async def _process_write(self, params: Message) -> JsonValue:
        proc = self._processes.get(arg(params, "processId", str))
        if proc is None:
            return {"status": "unknownProcess"}
        data = unb64(arg(params, "chunk", str, ""), "chunk")
        if proc.stdin is None or proc.stdin.closed:
            return {"status": "stdinClosed"}
        if proc.tty and constants.CODEX_CTRL_C in data:
            self._stop(proc, constants.CODEX_INTERRUPTED)
        elif proc.tty and data == constants.CODEX_CTRL_D:
            proc.stdin.close()
        elif data:
            proc.stdin.write(data)
        return {"status": "accepted"}

    async def _process_signal(self, params: Message) -> JsonValue:
        proc = self._known(params)
        signal = arg(params, "signal", str)
        if signal != constants.CODEX_INTERRUPT_SIGNAL:
            raise CodexRPCError(
                RPC_INVALID_PARAMS,
                f"unknown variant `{signal}`, expected "
                f"`{constants.CODEX_INTERRUPT_SIGNAL}`",
            )
        self._stop(proc, constants.CODEX_INTERRUPTED)
        return {}

    async def _process_terminate(self, params: Message) -> JsonValue:
        process_id = arg(params, "processId", str)
        proc = self._processes.get(process_id)
        if proc is None:
            return {"running": False}
        if proc.closed:
            del self._processes[process_id]
            return {"running": False}
        return {"running": self._stop(proc, constants.CODEX_TERMINATED)}

    async def _get_metadata(self, params: Message) -> JsonValue:
        path = to_path(arg(params, "path", str))
        return await self._fs(lambda core: metadata(core, path))

    async def _canonicalize(self, params: Message) -> JsonValue:
        path = to_path(arg(params, "path", str))

        async def canonical(core: MountCore) -> str:
            # The stat goes first: it refuses a link the session cannot
            # see before its target is named.
            await core.getattr(path, follow=True)
            return core.identity(path)

        return {"path": to_uri(await self._fs(canonical))}

    async def _read_file(self, params: Message) -> JsonValue:
        path = to_path(arg(params, "path", str))
        return {
            "dataBase64": b64(
                await self._fs(lambda core: read_file(core, path))
            )
        }

    async def _write_file(self, params: Message) -> JsonValue:
        path = to_path(arg(params, "path", str))
        data = unb64(arg(params, "dataBase64", str), "dataBase64")
        await self._fs(lambda core: write_file(core, path, data))
        return {}

    async def _create_directory(self, params: Message) -> JsonValue:
        path = to_path(arg(params, "path", str))
        if arg(params, "recursive", bool, False):
            await self._line(f"mkdir -p -- {shlex.quote(path)}")
        else:
            await self._fs(lambda core: make_directory(core, path))
        return {}

    async def _read_directory(self, params: Message) -> JsonValue:
        path = to_path(arg(params, "path", str))
        return {"entries": await self._fs(lambda core: directory(core, path))}

    async def _walk(self, params: Message) -> JsonValue:
        path = to_path(arg(params, "path", str))
        options = arg(params, "options", dict)
        return await self._fs(lambda core: walk(core, path, options))

    async def _remove(self, params: Message) -> JsonValue:
        path = to_path(arg(params, "path", str))
        recursive = arg(params, "recursive", bool, False)
        force = arg(params, "force", bool, False)
        st = await self._fs(lambda core: lookup(core, path))
        if st is None:
            if force:
                return {}
            raise rpc_error(
                FileNotFoundError(
                    posix_errno(FsCondition.ENOENT),
                    posix_phrase(FsCondition.ENOENT),
                )
            )
        if not stat.S_ISDIR(st["st_mode"]):
            await self._fs(lambda core: core.unlink(path))
        elif recursive:
            await self._line(f"rm -r -- {shlex.quote(path)}")
        else:
            await self._fs(lambda core: core.rmdir(path))
        return {}

    async def _copy(self, params: Message) -> JsonValue:
        source = to_path(arg(params, "sourcePath", str))
        destination = to_path(arg(params, "destinationPath", str))
        st = await self._fs(lambda core: followed(core, source))
        tree = stat.S_ISDIR(st["st_mode"])
        if tree and not arg(params, "recursive", bool, False):
            raise CodexRPCError(
                RPC_INVALID_REQUEST,
                "fs/copy requires recursive: true when sourcePath is a "
                "directory",
            )
        flag = "-R " if tree else ""
        await self._line(
            f"cp {flag}-- {shlex.quote(source)} {shlex.quote(destination)}"
        )
        return {}

    async def _open(self, params: Message) -> JsonValue:
        path = to_path(arg(params, "path", str))
        handle_id = arg(params, "handleId", str)
        if handle_id in self._handles:
            raise CodexRPCError(
                RPC_INVALID_REQUEST,
                f"file read handle `{handle_id}` already exists",
            )
        fh = await self._fs(lambda core: open_file(core, path))
        self._handles[handle_id] = (path, fh)
        return {"handleId": handle_id}

    async def _read_block(self, params: Message) -> JsonValue:
        handle_id = arg(params, "handleId", str)
        offset = arg(params, "offset", int)
        length = arg(params, "len", int)
        if handle_id not in self._handles:
            raise CodexRPCError(
                RPC_NOT_FOUND,
                f"unknown file read handle `{handle_id}`",
            )
        path, fh = self._handles[handle_id]
        chunk = await self._fs(
            lambda core: core.read(path, length, offset, fh)
        )
        return {"chunk": b64(chunk), "eof": len(chunk) < length}

    async def _close(self, params: Message) -> JsonValue:
        opened = self._handles.pop(arg(params, "handleId", str), None)
        if opened is not None:
            await self._release(opened[1])
        return {}


async def serve_codex(
    registry: WorkspaceRegistry, process: asyncssh.SSHServerProcess[str]
) -> None:
    """Serve one codex-exec channel in the workspace the login names.

    The channel runs in a fresh session, as ``open_login`` opens it.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        process (asyncssh.SSHServerProcess[str]): the channel's process.
    """
    opened = await open_login(registry, process, "codex")
    if opened is None:
        return
    entry, session_id = opened
    status = await CodexChannel(registry, entry, session_id, process).serve()
    process.exit(status)
