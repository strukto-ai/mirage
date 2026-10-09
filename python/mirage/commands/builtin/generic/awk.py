from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Coroutine,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from functools import partial
from typing import Any

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.awk_types import USAGE, AwkFlags
from mirage.commands.builtin.utils.paths import dispatch_stat
from mirage.commands.builtin.utils.stream import is_stdin, resolve_source
from mirage.commands.constants import ROOT_CWD
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.core.awk import (
    AwkIOError,
    AwkRuntimeError,
    AwkSyntaxError,
    CommandRun,
    ExitProgram,
    Interpreter,
    parse,
)
from mirage.core.awk.builtins import unescape
from mirage.core.awk.value import text as text_value
from mirage.errors.constants import FS_ERRORS, WALK_ERRORS
from mirage.errors.fs import eisdir, fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.io.cooperative import chunks
from mirage.io.stream import materialize
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn, ShellFn
from mirage.shell.bytes import (
    byte_view,
    decode_text,
    from_byte_view,
    text_view,
)
from mirage.shell.join import shell_join
from mirage.types import FileType, PathSpec
from mirage.view.types import NamespaceView

STDIN_NAMES = frozenset({"-", "/dev/stdin"})


def parse_flags(fl: FlagView) -> AwkFlags:
    """Read the raw awk flag kwargs into a frozen struct.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    raw_f = fl.raw("f")
    if isinstance(raw_f, PathSpec):
        program_files: tuple[PathSpec, ...] = (raw_f,)
    elif isinstance(raw_f, list):
        program_files = tuple(p for p in raw_f if isinstance(p, PathSpec))
    else:
        program_files = ()
    return AwkFlags(
        field_separator=fl.as_str("F"),
        assignments=tuple(fl.as_list("v")),
        program_files=program_files,
    )


def split_assignments(raw: Sequence[str]) -> dict[str, str]:
    """Turn -v NAME=VALUE arguments into a mapping, last one winning.

    Args:
        raw (Sequence[str]): the raw -v arguments.
    """
    out: dict[str, str] = {}
    for item in raw:
        if "=" in item:
            key, value = item.split("=", 1)
            out[key] = unescape(byte_view(value))
    return out


def served_here(
    ns: NamespaceView | None, mount_prefix: str, path: PathSpec
) -> bool:
    """Whether the mount awk runs on serves an operand.

    A line whose operands span mounts runs awk once, on its first file's
    mount; an operand another mount serves is read through the dispatcher.

    Args:
        ns (NamespaceView | None): the name plane's facts, None outside a
            workspace, where every operand is the mount's own.
        mount_prefix (str): the prefix of the mount awk runs on.
        path (PathSpec): the operand.
    """
    if ns is None or ns.mounts is None:
        return True
    home = mount_prefix.rstrip("/")
    return ns.mounts.root_of(path.virtual).rstrip("/") == home


async def _guarded(source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """Relay a stream, a filesystem failure becoming awk's ``AwkIOError``.

    Args:
        source (AsyncIterator[bytes]): the stream.
    """
    try:
        async with aclosing(chunks(source)) as pulled:
            async for chunk in pulled:
                yield chunk
    except FS_ERRORS as exc:
        raise AwkIOError(
            fs_strerror(exc) or posix_phrase(FsCondition.ENOENT)
        ) from exc


class AwkStreams:
    """The files and commands one awk run reaches, through the workspace.

    Operands still holding their command-line value read through the
    mount's own reader, the way they were resolved, unless another mount
    serves them (a line spanning mounts); every other name
    (``getline < file``, an ARGV slot the program filled) reads through
    the dispatcher, as output redirection writes through it. Every
    stdin reader, a ``-`` operand, ``getline < "-"`` and a command's
    inherited input alike, shares one cursor, so none replays what
    another read.

    Args:
        operands (Sequence[PathSpec]): the operands as classified.
        read_stream (Callable[..., AsyncIterator[bytes]]): the mount's
            reader for an operand.
        stdin (ByteSource | None): awk's standard input.
        dispatch (DispatchFn | None): the workspace dispatcher.
        cwd (PathSpec): the directory relative names resolve against.
        shell (ShellFn | None): runs a nested line in the session.
        local (Callable[[PathSpec], bool]): whether this mount serves an
            operand.
    """

    def __init__(
        self,
        operands: Sequence[PathSpec],
        read_stream: Callable[..., AsyncIterator[bytes]],
        stdin: ByteSource | None,
        dispatch: DispatchFn | None,
        cwd: PathSpec,
        shell: ShellFn | None,
        local: Callable[[PathSpec], bool],
    ) -> None:
        self.local = local
        self.operands = operands
        self.read_stream = read_stream
        self.stdin = resolve_source(stdin)
        self.dispatch = dispatch
        self.cwd = cwd
        self.shell = shell

    async def stdin_view(self) -> AsyncIterator[bytes]:
        async for chunk in self.stdin:
            yield chunk

    async def read_path(self, name: str | PathSpec) -> AsyncIterator[bytes]:
        if self.dispatch is None:
            raise AwkIOError(posix_phrase(FsCondition.ENOENT))
        path = PathSpec.from_str_path(name, cwd=self.cwd.virtual)
        # A keyed store reads a directory as nothing at all, and other
        # backends fail it in their own words, so the stat goes first to
        # fail it the way a POSIX read does.
        if (
            await dispatch_stat(self.dispatch, path)
        ).type == FileType.DIRECTORY:
            raise eisdir(path)
        data, _ = await self.dispatch("read", path)
        yield data

    def open_input(self, name: str, index: int | None) -> AsyncIterator[bytes]:
        """Open an input stream by name (see ``AwkHost.open_input``).

        Args:
            name (str): the file name, ``-`` or ``/dev/stdin`` for stdin.
            index (int | None): the ARGV slot the name was read from.
        """
        name = text_view(name)
        if index is not None and 0 < index <= len(self.operands):
            operand = self.operands[index - 1]
            if operand.raw_path == name:
                if is_stdin(operand):
                    return _guarded(self.stdin_view())
                if self.local(operand):
                    return _guarded(self.read_stream(operand))
                return _guarded(self.read_path(operand))
        if name in STDIN_NAMES:
            return _guarded(self.stdin_view())
        return _guarded(self.read_path(name))

    async def write_file(self, name: str, body: str, append: bool) -> None:
        """Write output text through the dispatcher.

        Args:
            name (str): the file name as the program spelled it.
            body (str): the text to write.
            append (bool): append rather than replace the file.
        """
        if self.dispatch is None:
            raise AwkRuntimeError("awk: file output requires a workspace")
        path = PathSpec.from_str_path(text_view(name), cwd=self.cwd.virtual)
        try:
            await self.dispatch(
                "append" if append else "write",
                path,
                data=from_byte_view(body),
            )
        except WALK_ERRORS as exc:
            raise AwkIOError(
                fs_strerror(exc) or "Cannot write output file"
            ) from exc

    async def run(self, command: str, stdin: bytes | None) -> CommandRun:
        """Run a command line in a subshell of the session, as sh -c would.

        ``eval`` takes the line whole, so an empty one, a comment or a
        line ending in a backslash runs as ``sh -c`` would run it.

        Args:
            command (str): the command line.
            stdin (bytes | None): its input, None for awk's own.
        """
        if self.shell is None:
            raise AwkRuntimeError(
                "awk: running a command requires a workspace"
            )
        source: ByteSource = self.stdin_view() if stdin is None else stdin
        io = await self.shell(
            f"( {shell_join(['eval', text_view(command)])} )", source
        )
        out = await materialize(io.stdout) if io.stdout is not None else b""
        err = await materialize(io.stderr) if io.stderr is not None else b""
        return CommandRun(out, err, io.exit_code)


async def _stage(step: Coroutine[Any, Any, None], io: IOResult) -> bool:
    """Run one phase of the program; True when it ran ``exit``.

    Args:
        step (Coroutine[Any, Any, None]): the phase.
        io (IOResult): receives the exit status.
    """
    try:
        await step
    except ExitProgram as stop:
        io.exit_code = stop.code & 0xFF
        return True
    return False


def _add_stderr(io: IOResult, err: bytes) -> None:
    if err:
        held = io.stderr if isinstance(io.stderr, bytes) else b""
        io.stderr = held + err


async def _drained(interp: Interpreter, io: IOResult) -> bytes:
    out, err = await interp.drain()
    _add_stderr(io, err)
    return out


async def _awk_stream(
    interp: Interpreter, io: IOResult
) -> AsyncIterator[bytes]:
    """Run the program, yielding standard output as each record settles.

    ``exit`` in BEGIN skips the input and in the main rules stops it,
    and END runs after either; every awk treats a runtime error as fatal
    at exit 2 and keeps what it had already written.

    Args:
        interp (Interpreter): the interpreter.
        io (IOResult): receives the exit status and stderr.
    """
    try:
        exited = await _stage(interp.run_begin(), io)
        yield await _drained(interp, io)
        if not exited and interp.has_main_rules():
            while (record := await interp.next_record()) is not None:
                if await _stage(interp.run_record(record), io):
                    break
                chunk = await _drained(interp, io)
                if chunk:
                    yield chunk
        await _stage(interp.run_end(), io)
        await interp.finish()
        yield await _drained(interp, io)
    except (AwkRuntimeError, AwkSyntaxError) as exc:
        out, err = await interp.salvage(exc)
        io.exit_code = 2
        _add_stderr(io, err)
        yield out
    finally:
        await interp.close_inputs()


async def awk_generic(
    paths: list[PathSpec],
    texts: Sequence[str] = (),
    flags: Mapping[str, FlagValue] | None = None,
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    index: IndexCacheStore = NULL_INDEX,
    dispatch: DispatchFn | None = None,
    cwd: PathSpec = ROOT_CWD,
    shell: ShellFn | None = None,
    ns: NamespaceView | None = None,
    mount_prefix: str = "",
    env: Mapping[str, str] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run an awk program over backend paths or stdin.

    Interprets the raw flag kwargs itself (TS awkGeneric parity), so backend
    wrappers only wire paths, texts, flags, and backend I/O.

    Args:
        paths (list[PathSpec]): Data files to process in order. Empty paths
            consume stdin.
        texts (Sequence[str]): positional TEXT operands (the program unless
            -f supplied it).
        flags (Mapping[str, FlagValue] | None): raw flag kwargs from the
            dispatcher (F, v, f).
        read_bytes (Callable[..., Awaitable[bytes]]): Whole-file reader used
            for the -f program file.
        read_stream (Callable[..., AsyncIterator[bytes]]): Streaming reader
            for data files.
        stdin (ByteSource | None): Standard input.
        index (IndexCacheStore): The mount's index cache store.
        dispatch (DispatchFn | None): The workspace dispatcher that
            ``getline < file`` reads and output redirection writes
            through.
        cwd (PathSpec): What relative file names resolve against.
        shell (ShellFn | None): Runs the command of a pipe or
            ``system()``.
        ns (NamespaceView | None): The name plane's facts, which say
            which operands another mount serves.
        mount_prefix (str): The prefix of the mount awk runs on.
        env (Mapping[str, str] | None): The exported environment, which
            ENVIRON holds.

    Returns:
        tuple[ByteSource | None, IOResult]: Output stream and exit metadata.
    """
    fl = FlagView(flags, spec=SPECS["awk"])
    f = parse_flags(fl)

    if f.program_files:
        pieces: list[str] = []
        for prog in f.program_files:
            try:
                raw = await read_bytes(prog)
            except (FileNotFoundError, NotADirectoryError) as exc:
                # GNU awk exits 2 when a -f program file cannot be opened.
                raise UsageError(
                    f"awk: {prog.raw_path}: {fs_strerror(exc)}"
                ) from exc
            pieces.append(decode_text(raw))
        source = "\n".join(pieces)
    elif texts:
        source = texts[0]
    else:
        raise UsageError(USAGE)

    try:
        program = parse(source)
    except AwkSyntaxError as exc:
        return None, IOResult(exit_code=2, stderr=from_byte_view(f"{exc}\n"))

    # An empty operand names no file and mawk skips it, as it does an
    # operand ARGV no longer holds; a `var=value` operand is assigned
    # when the input reaches it. FILENAME reports the operand as typed.
    streams = AwkStreams(
        paths,
        read_stream,
        stdin,
        dispatch,
        cwd,
        shell,
        partial(served_here, ns, mount_prefix),
    )
    interp = Interpreter(
        program,
        streams,
        [byte_view(p.raw_path) for p in paths],
        split_assignments(f.assignments),
        {byte_view(k): byte_view(v) for k, v in (env or {}).items()},
    )
    if f.field_separator is not None:
        interp.set_var(
            "FS", text_value(unescape(byte_view(f.field_separator)))
        )

    io = IOResult()
    return _awk_stream(interp, io), io


__all__ = ["awk_generic"]
