import codecs
from collections.abc import (AsyncGenerator, AsyncIterator, Awaitable,
                             Callable, Mapping, Sequence)
from contextlib import aclosing

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.awk_types import (FS_ESCAPES, USAGE,
                                                       AwkFlags)
from mirage.commands.builtin.utils.stream import (is_stdin, resolve_source,
                                                  stdin_stream)
from mirage.commands.constants import ROOT_CWD
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.core.awk import (AwkRuntimeError, AwkSyntaxError, ExitProgram,
                             Interpreter, parse)
from mirage.core.awk.builtins import take_record
from mirage.core.awk.value import text as text_value
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource, IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec
from mirage.utils.errors import WALK_ERRORS, fs_strerror
from mirage.utils.path import resolve_path


def parse_flags(fl: FlagView) -> AwkFlags:
    """Read the raw awk flag kwargs into a frozen struct.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    raw_f = fl.raw("f")
    if isinstance(raw_f, PathSpec):
        program_files: tuple[PathSpec, ...] = (raw_f, )
    elif isinstance(raw_f, list):
        program_files = tuple(p for p in raw_f if isinstance(p, PathSpec))
    else:
        program_files = ()
    return AwkFlags(
        field_separator=fl.as_str("F"),
        assignments=tuple(fl.as_list("v")),
        program_files=program_files,
    )


def unescape(raw: str) -> str:
    """Expand the backslash escapes awk reads in a -F or -v argument.

    Args:
        raw (str): the argument as typed on the command line.
    """
    out: list[str] = []
    idx = 0
    while idx < len(raw):
        if raw[idx] == "\\" and idx + 1 < len(raw):
            nxt = raw[idx + 1]
            out.append(FS_ESCAPES.get(nxt, "\\" + nxt))
            idx += 2
            continue
        out.append(raw[idx])
        idx += 1
    return "".join(out)


def split_assignments(raw: Sequence[str]) -> dict[str, str]:
    """Turn -v NAME=VALUE arguments into a mapping, last one winning.

    Args:
        raw (Sequence[str]): the raw -v arguments.
    """
    out: dict[str, str] = {}
    for item in raw:
        if "=" in item:
            key, value = item.split("=", 1)
            out[key] = unescape(value)
    return out


async def _settle(io: IOResult, interp: Interpreter,
                  failure: AwkRuntimeError | AwkSyntaxError | None,
                  dispatch: DispatchFn | None,
                  cwd: PathSpec) -> tuple[bytes, bool]:
    out: list[str] = []
    err = ""
    pending = interp.drain_output()
    for name, body, append in pending:
        if name is None:
            out.append(body)
        elif name == "/dev/stderr":
            err += body
        else:
            if dispatch is None:
                failure = AwkRuntimeError(
                    "awk: file output requires a workspace")
                break
            path = PathSpec.from_str_path(resolve_path(name, cwd.virtual))
            try:
                await dispatch("append" if append else "write",
                               path,
                               data=body.encode())
            except WALK_ERRORS as exc:
                detail = fs_strerror(exc) or "Cannot write output file"
                failure = AwkRuntimeError(
                    f'awk: cannot open "{name}" for output ({detail})')
                break
    if failure is not None:
        io.exit_code = 2
        err += f"{failure}\n"
    if err:
        held = io.stderr if isinstance(io.stderr, bytes) else b""
        io.stderr = held + err.encode()
    return "".join(out).encode(), failure is not None


async def _records(source: AsyncIterator[bytes],
                   interp: Interpreter) -> AsyncGenerator[str, None]:
    """Cut one input into records with the RS in force at each read.

    RS is read again before every record, so an action that assigns it
    changes how the next record is cut, as in every awk.

    Args:
        source (AsyncIterator[bytes]): the input bytes.
        interp (Interpreter): the interpreter whose RS applies.
    """
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    budget = YieldBudget()
    buffer = ""
    start = 0
    final = False
    async with aclosing(chunks(source)) as pulled:
        while not final:
            data = await anext(pulled, None)
            final = data is None
            buffer = buffer[start:] + decoder.decode(data or b"", final)
            start = 0
            while True:
                await budget.run()
                record, start = take_record(buffer, start,
                                            interp.special("RS"), final)
                if record is None:
                    break
                yield record


async def _awk_stream(
    sources: Sequence[tuple[str, AsyncIterator[bytes]]],
    interp: Interpreter,
    io: IOResult,
    dispatch: DispatchFn | None,
    cwd: PathSpec,
) -> AsyncIterator[bytes]:
    exited = False
    try:
        interp.run_begin()
    except ExitProgram as stop:
        io.exit_code = stop.code & 0xFF
        exited = True
    except (AwkRuntimeError, AwkSyntaxError) as exc:
        chunk, _ = await _settle(io, interp, exc, dispatch, cwd)
        yield chunk
        return
    chunk, failed = await _settle(io, interp, None, dispatch, cwd)
    yield chunk
    if failed:
        return
    if not exited and interp.has_main_rules():
        for name, source in sources:
            if exited:
                break
            interp.start_file(name)
            try:
                async with aclosing(_records(source, interp)) as records:
                    async for record in records:
                        interp.run_record(record)
                        chunk, failed = await _settle(io, interp, None,
                                                      dispatch, cwd)
                        if chunk:
                            yield chunk
                        if failed:
                            return
                        if interp.skip_file:
                            break
            except ExitProgram as stop:
                io.exit_code = stop.code & 0xFF
                exited = True
            except (AwkRuntimeError, AwkSyntaxError) as exc:
                chunk, _ = await _settle(io, interp, exc, dispatch, cwd)
                yield chunk
                return
    try:
        interp.run_end()
    except ExitProgram as stop:
        io.exit_code = stop.code & 0xFF
    except (AwkRuntimeError, AwkSyntaxError) as exc:
        chunk, _ = await _settle(io, interp, exc, dispatch, cwd)
        yield chunk
        return
    chunk, failed = await _settle(io, interp, None, dispatch, cwd)
    yield chunk
    if failed:
        return


async def awk(
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
            except FileNotFoundError as exc:
                # GNU awk exits 2 when a -f program file cannot be opened.
                raise UsageError(f"awk: {prog.raw_path}: "
                                 "No such file or directory") from exc
            pieces.append(raw.decode(errors="replace"))
        source = "\n".join(pieces)
    elif texts:
        source = texts[0]
    else:
        raise UsageError(USAGE)

    try:
        program = parse(source)
    except AwkSyntaxError as exc:
        raise UsageError(str(exc)) from exc

    interp = Interpreter(program, split_assignments(f.assignments))
    if f.field_separator is not None:
        interp.set_var("FS", text_value(unescape(f.field_separator)))

    read_stream = stdin_stream(read_stream, stdin)
    if paths:
        # FILENAME reports the operand as typed, matching every awk.
        sources = [(p.raw_path, read_stream(p)) for p in paths]
        cache = [p.mount_path for p in paths if not is_stdin(p)]
    else:
        sources = [("", resolve_source(stdin))]
        cache = []

    io = IOResult(cache=cache)
    return _awk_stream(sources, interp, io, dispatch, cwd), io


__all__ = ["awk"]
