import re
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import aclosing
from functools import partial

from mirage.commands.builtin.constants import AWK_USAGE
from mirage.commands.builtin.generic.awk_types import AwkFlags
from mirage.commands.builtin.utils.links import mount_view
from mirage.commands.builtin.utils.stream import is_stdin
from mirage.commands.builtin.utils.stream_host import StreamHost
from mirage.commands.constants import ROOT_CWD
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.stream import OpenStream, open_stream, serve_requests
from mirage.runtime.types import DispatchFn, ShellFn
from mirage.shell.bytes import byte_view, decode_text
from mirage.types import PathSpec, ReadStreamFn
from mirage.workspace.files import Files

ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")


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


def is_assignment(operand: str) -> bool:
    """Whether an operand is a ``var=value`` assignment, not a file:
    POSIX makes it one when a name comes before its ``=``.

    Args:
        operand (str): the operand as typed.
    """
    return ASSIGNMENT.match(operand) is not None


def home_operand(scopes: list[PathSpec]) -> PathSpec:
    """The operand whose mount runs the program: its first file.

    Args:
        scopes (list[PathSpec]): The operands in command-line order.
    """
    for scope in scopes:
        if (
            scope.raw_path != ""
            and not is_stdin(scope)
            and not is_assignment(scope.raw_path)
        ):
            return scope
    return scopes[0]


def served_here(vfs: Files | None, mount_prefix: str, path: PathSpec) -> bool:
    """Whether the mount awk runs on serves an operand.

    A line whose operands span mounts runs awk once, on its first file's
    mount; an operand another mount serves is read through the dispatcher.

    Args:
        vfs (Files | None): the name plane's facts, None outside a
            workspace, where every operand is the mount's own.
        mount_prefix (str): the prefix of the mount awk runs on.
        path (PathSpec): the operand.
    """
    mounts = mount_view(vfs)
    if vfs is None or mounts is None:
        return True
    home = mount_prefix.rstrip("/")
    return mounts.root_of(path.virtual).rstrip("/") == home


async def _awk_stream(
    stream: OpenStream, host: StreamHost, io: IOResult
) -> AsyncIterator[bytes]:
    """Run the program, yielding standard output as it settles.

    Args:
        stream (OpenStream): the awk engine.
        host (StreamHost): serves the files and commands it reaches.
        io (IOResult): receives the exit status and stderr.
    """
    try:
        async with aclosing(serve_requests(stream, host)) as output:
            async for chunk in output:
                yield chunk
        io.exit_code = stream.status()
    finally:
        io.stderr = await host.errors.output()
        await host.close()


async def awk_generic(
    paths: list[PathSpec],
    texts: Sequence[str] = (),
    flags: Mapping[str, FlagValue] | None = None,
    *,
    stream: ReadStreamFn,
    stdin: ByteSource | None = None,
    dispatch: DispatchFn | None = None,
    cwd: PathSpec = ROOT_CWD,
    shell: ShellFn | None = None,
    vfs: Files | None = None,
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
        stream (ReadStreamFn): the mount's reader, for the -f program
            files and the data files.
        stdin (ByteSource | None): Standard input.
        dispatch (DispatchFn | None): The workspace dispatcher that
            ``getline < file`` reads and output redirection writes
            through.
        cwd (PathSpec): What relative file names resolve against.
        shell (ShellFn | None): Runs the command of a pipe or
            ``system()``.
        vfs (Files | None): The name plane's facts, which say
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
                raw = await materialize(stream(prog))
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
        raise UsageError(AWK_USAGE)

    # An empty operand names no file and mawk skips it, as it does an
    # operand ARGV no longer holds; a `var=value` operand is assigned
    # when the input reaches it. FILENAME reports the operand as typed.
    engine = open_stream(
        "awk",
        {
            "program": byte_view(source),
            "operands": [byte_view(p.raw_path) for p in paths],
            "assignments": [byte_view(a) for a in f.assignments],
            "fs": (
                None
                if f.field_separator is None
                else byte_view(f.field_separator)
            ),
            "environ": [
                byte_view(f"{name}={value}")
                for name, value in (env or {}).items()
            ],
        },
    )
    if not engine.busy():
        return None, IOResult(exit_code=2, stderr=engine.take_stderr())
    host = StreamHost(
        paths,
        stream,
        stdin,
        dispatch,
        cwd,
        shell,
        partial(served_here, vfs, mount_prefix),
    )
    io = IOResult()
    return _awk_stream(engine, host, io), io


__all__ = ["awk_generic", "is_assignment"]
