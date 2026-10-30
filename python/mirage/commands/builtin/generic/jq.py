# The program file and the exit statuses follow jq 1.8.2's src/main.c
# (MIT; see licenses/third_party/jq.txt).

import json
import logging
import posixpath
import time
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Iterator,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass

from mirage.commands.builtin.generic.program import (
    program_file_refusal,
    read_program_file,
)
from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.builtin.utils.stream import is_stdin, stdin_stream
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.constants import OPERAND, REFUSED
from mirage.commands.spec.flag_view import FlagView, spec_flag_names
from mirage.commands.spec.standard import help_page, version_line
from mirage.commands.spec.types import FlagValue
from mirage.core.jq import STDIN_NAME, local_zone
from mirage.core.jq.eval import COMPILE_REPORT
from mirage.errors.constants import FS_ERRORS, READ_FAILURES
from mirage.errors.fs import fs_strerror
from mirage.io.cooperative import chunks
from mirage.io.errors import MemoryExhausted
from mirage.io.memory import memory_room
from mirage.io.spool import ByteSpool
from mirage.io.stream import close_quietly, yield_bytes
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused
from mirage.rs.stream import (
    OpenStream,
    Served,
    close_stream,
    open_stream,
    serve_requests,
)
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec, ReadStreamFn

logger = logging.getLogger(__name__)

# The bindings, whose name and value the bag keeps as typed, and those
# whose value is a file the option loop asks for.
BINDINGS = ("arg", "argjson", "rawfile", "slurpfile")
FILE_BINDINGS = ("rawfile", "slurpfile")

# jq's exit status when it refuses the program itself, and when the
# program file holds a NUL byte.
ERROR_COMPILE = 3
ERROR_SYSTEM = 2


def _bound_words(fl: FlagView, dest: str) -> Iterator[FlagValue]:
    """The words one binding option holds, in the order typed: each name,
    then the value it binds, or for a file binding the file.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        dest (str): the option's kwarg name.
    """
    raw = fl.raw(dest)
    for at, word in enumerate(raw if isinstance(raw, list) else []):
        yield _file_of(word) if at % 2 and dest in FILE_BINDINGS else word


def _file_of(word: FlagValue | None) -> PathSpec:
    """The file a flag names: the PathSpec of the word typed, or one built
    from the resolved path the flag arrived as.

    Args:
        word (FlagValue | None): the flag's value.
    """
    if isinstance(word, PathSpec):
        return word
    if isinstance(word, str):
        return PathSpec.from_str_path(word)
    raise ValueError(f"jq: a flag names no file: {word!r}")


def option_tape(
    fl: FlagView, texts: Sequence[str]
) -> tuple[list[tuple[str, str]], dict[int, PathSpec]]:
    """jq's words in the order typed, as mirage-rs's option loop reads
    them, and the file at each place on them that names one.

    The bag's tape keeps where each word was typed, and the bag what it
    was: a binding's name and value, and the file -f names, which the
    tape holds resolved. A file is named as the word typed. Operands the
    bag has no tape for (keyword flags) come after every option.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        texts (Sequence[str]): the text operands.
    """
    bound = {dest: _bound_words(fl, dest) for dest in BINDINGS}
    tape: list[tuple[str, str]] = []
    files: dict[int, PathSpec] = {}
    names = spec_flag_names(SPECS["jq"])
    for dest, value in fl.occurrences(*names, OPERAND, REFUSED):
        if dest in bound:
            word = next(bound[dest], "")
        elif dest == "from_file":
            word = _file_of(fl.raw(dest))
        else:
            word = value
        if isinstance(word, PathSpec):
            files[len(tape)] = word
            tape.append((dest, flag_file_name(word)))
        elif isinstance(word, str):
            tape.append((dest, word))
        elif word is True:
            tape.append((dest, ""))
        elif word is not False:
            raise ValueError(f"jq: {dest} holds no word: {word!r}")
    if not any(dest == OPERAND for dest, _ in tape):
        tape.extend((OPERAND, word) for word in texts)
    return tape, files


class FlagFiles:
    """Serves the files the option loop asks for: each --rawfile and
    --slurpfile it reaches, read the way jq reads its inputs.

    Args:
        files (Mapping[int, PathSpec]): the file at each place on the
            tape (option_tape).
        read (Callable): byte reader for one path.
    """

    def __init__(
        self,
        files: Mapping[int, PathSpec],
        read: Callable[[PathSpec], Awaitable[bytes]],
    ) -> None:
        self._files = files
        self._read = read
        self.errors = ByteSpool()

    async def serve(
        self, request: Mapping[str, JsonValue], data: bytes
    ) -> Served:
        """Read one file, or say why it could not be read.

        Args:
            request (Mapping[str, JsonValue]): ``{"op": "read", "at": i}``.
            data (bytes): unused; a read carries no bytes.
        """
        at = request.get("at")
        if request.get("op") != "read" or not isinstance(at, int):
            raise ValueError(f"jq: unknown option loop request {request}")
        try:
            return Served({"kind": "data"}, await self._read(self._files[at]))
        except FS_ERRORS as exc:
            return Served(
                {
                    "kind": "error",
                    "message": fs_strerror(exc),
                    "directory": isinstance(exc, IsADirectoryError),
                }
            )


@dataclass(frozen=True)
class OptionPlan:
    """What jq's option loop decided for a run.

    Args:
        config (Mapping[str, JsonValue]): the run config the options
            decide.
        program (str | PathSpec): the program as the operand typed it,
            or the file -f names.
    """

    config: Mapping[str, JsonValue]
    program: str | PathSpec


async def read_options(
    tape: Sequence[tuple[str, str]],
    files: Mapping[int, PathSpec],
    read: Callable[[PathSpec], Awaitable[bytes]],
) -> OptionPlan | bytes | IOResult:
    """jq's option loop in mirage-rs: the run it decides, what --help or
    --version prints where the loop reaches one, or the first word it
    refuses as the command's result, in jq's words.

    Args:
        tape (Sequence[tuple[str, str]]): the words (option_tape).
        files (Mapping[int, PathSpec]): the file at each place on it.
        read (Callable): byte reader for a --rawfile or --slurpfile.

    Raises:
        ValueError: a reply that lacks what the loop always answers.
    """
    try:
        stream = open_stream(
            "jq_options",
            {"options": [[name, byte_view(text)] for name, text in tape]},
        )
    except StreamRefusal as refusal:
        return refused(refusal)
    host = FlagFiles(files, read)
    try:
        async with aclosing(serve_requests(stream, host)) as output:
            reply = b"".join([chunk async for chunk in output])
    except StreamRefusal as refusal:
        return refused(refusal)
    finally:
        await host.errors.close()
        await close_stream(stream)
    plan = json.loads(reply)
    match plan:
        case {"answer": "help"}:
            return help_page("jq", SPECS["jq"])
        case {"answer": "version"}:
            return version_line("jq")
        case {
            "config": {"program": str(text)} as config,
            "program_file": None,
        }:
            return OptionPlan(config, text)
        case {"config": dict() as config, "program_file": int(at)}:
            return OptionPlan(config, files[at])
    raise ValueError(f"jq: the option loop answered {plan}")


def input_name(path: PathSpec) -> str:
    """An input as jq's reports name it: the operand as typed, and
    `<stdin>` for `-`.

    Args:
        path (PathSpec): the operand.
    """
    if path.raw_path == "-":
        return STDIN_NAME
    return path.raw_path or path.virtual


def flag_file_name(path: PathSpec) -> str:
    """A flag's file as jq's reports name it: the word typed, `-` included,
    since jq opens that one as a file too.

    Args:
        path (PathSpec): the file an -f, --rawfile or --slurpfile names.
    """
    return path.raw_path or path.virtual


# What the stream ends with once what jq holds outgrows the workspace's
# room (mirage-rs's jq EXHAUSTED).
EXHAUSTED = str(MemoryExhausted())


class JqInputs:
    """The inputs jq's main loop reads, each opened when the loop first
    asks for its bytes, as jq opens its files one after another, and the
    clock `now` reads. An input goes over in bounded pieces, so the loop
    holds no more of it than it is reading.

    Args:
        sources (Sequence[AsyncIterator[bytes]]): the inputs, in order, not
            yet opened.
    """

    def __init__(self, sources: Sequence[AsyncIterator[bytes]]) -> None:
        self._sources = [chunks(source) for source in sources]
        self.errors = ByteSpool()

    async def serve(
        self, request: Mapping[str, JsonValue], data: bytes
    ) -> Served:
        """Answer the stream: the clock, or the next bytes of an input, its
        end, or why it could not be opened or read, in strerror's words.

        Args:
            request (Mapping[str, JsonValue]): ``{"op": "now"}``, or
                ``{"op": "read", "input": i}``.
            data (bytes): unused; a read carries no bytes.
        """
        if request.get("op") == "now":
            return Served({"kind": "now", "now": time.time()})
        index = request.get("input")
        if request.get("op") != "read" or not isinstance(index, int):
            raise ValueError(f"jq: unknown host request {request}")
        source = self._sources[index]
        try:
            chunk = await anext(source, None)
        except FS_ERRORS as exc:
            return Served(
                {
                    "kind": "error",
                    "message": fs_strerror(exc),
                    "read": isinstance(exc, READ_FAILURES),
                }
            )
        if chunk is None:
            return Served({"kind": "end"})
        return Served({"kind": "data"}, chunk)

    async def close(self) -> None:
        """Close every input, the one the loop stopped in among them."""
        for source in self._sources:
            await close_quietly(source)


def run_config(
    expr: str,
    options: Mapping[str, JsonValue],
    env: str,
    zone: str | None,
    origin: str | None,
    inputs: Sequence[str],
) -> dict[str, JsonValue]:
    """What mirage-rs's jq takes for one invocation.

    Args:
        expr (str): jq program text.
        options (Mapping[str, JsonValue]): what the option loop decided
            (read_options).
        env (str): the environment `$ENV` and `env` read, as text.
        zone (str | None): the `TZ` local time reads (local_zone).
        origin (str | None): the directory `get_prog_origin` answers.
        inputs (Sequence[str]): the inputs' names as jq reports them.
    """
    limit = memory_room()
    return {
        **options,
        "program": expr,
        "env": env,
        "zone": zone,
        "prog_origin": origin,
        **({} if limit is None else {"memory": limit}),
        "inputs": list(inputs),
    }


async def run_outputs(
    config: Mapping[str, JsonValue], inputs: JqInputs, io: IOResult
) -> AsyncIterator[bytes]:
    """jq's main loop in mirage-rs over the inputs, a bounded slice of
    work at a time: what the runs print, as they print it, with jq's
    exit status and stderr settled on ``io`` once the stream is drained.

    Args:
        config (Mapping[str, JsonValue]): the invocation (run_config).
        inputs (JqInputs): serves the inputs and the clock.
        io (IOResult): the result to settle.

    Raises:
        MemoryExhausted: what jq holds outgrew the workspace's room,
            after what was printed before it.
    """
    stream = open_stream("jq", config)
    try:
        async with aclosing(serve_requests(stream, inputs)) as output:
            async for chunk in output:
                yield chunk
    except StreamRefusal as exc:
        if exc.message != EXHAUSTED:
            raise
        if exc.output:
            yield exc.output
        raise MemoryExhausted() from exc
    finally:
        await _close_run(stream, inputs, io)


async def _close_run(
    stream: OpenStream, inputs: JqInputs, io: IOResult
) -> None:
    """Settle a run's exit status and stderr on ``io``, then close its
    inputs and its stream, whatever settling raised: a spool that lost a
    write cannot hand its contents on, and still frees what it holds.

    Args:
        stream (OpenStream): the run's stream.
        inputs (JqInputs): its inputs and stderr spool.
        io (IOResult): the result to settle.
    """
    try:
        io.exit_code = stream.status()
        await inputs.errors.append(stream.take_stderr())
        io.stderr = await inputs.errors.output()
    except BaseException:
        await inputs.errors.close()
        raise
    finally:
        await inputs.close()
        await close_stream(stream)


async def jq_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stream: ReadStreamFn,
) -> tuple[ByteSource | None, IOResult]:
    """Full-command jq entry; mirrors jqGeneric's (paths, texts, ctx).

    The dispatcher-facing seam, so the builder stays wiring. It hands the
    flag bag on whole: the bag records the order the flags were typed in,
    which read_options reads and keywords would lose.
    """
    return await _jq(
        paths,
        texts,
        ctx.flags,
        stream,
        ctx.stdin,
        dispatch_of(ctx),
        ctx.env,
        ctx.cwd,
    )


async def jq(
    paths: list[PathSpec],
    *texts: str,
    stream: ReadStreamFn,
    stdin: ByteSource | None = None,
    dispatch: DispatchFn | None = None,
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    """jq over keyword flags, the historical shape; keywords keep no record
    of the order they were typed in (see jq_generic)."""
    return await _jq(paths, texts, flags, stream, stdin, dispatch, None, None)


async def _jq(
    paths: list[PathSpec],
    texts: Sequence[str],
    flags: Mapping[str, FlagValue],
    stream: ReadStreamFn,
    stdin: ByteSource | None,
    dispatch: DispatchFn | None,
    env: Mapping[str, str] | None,
    cwd: PathSpec | None,
) -> tuple[ByteSource | None, IOResult]:
    """Run one jq invocation.

    Args:
        paths (list[PathSpec]): the input operands.
        texts (Sequence[str]): the text operands, program first unless -f
            gave it.
        flags (Mapping[str, FlagValue]): the flag bag.
        stream (ReadStreamFn): chunk reader for one path.
        stdin (ByteSource | None): the invocation's stdin.
        dispatch (DispatchFn | None): the dispatcher a flag's file is read
            through.
        env (Mapping[str, str] | None): the session's exported
            environment, which `$ENV` and `env` read in place of jq's
            process environment, and whose `TZ` local time reads.
        cwd (PathSpec | None): the session's working directory, which
            `get_prog_origin` answers without -f.
    """
    fl = FlagView(flags, spec=SPECS["jq"])
    read_input = stdin_stream(stream, stdin)

    async def read_flag_file(path: PathSpec) -> bytes:
        # -f, --rawfile and --slurpfile route nothing (the executor's
        # FILE_KEYS and DISPATCH_FLAG_KEYS), so the file may sit on another
        # mount than the operands: it is read through the dispatcher. jq opens
        # it by name, so /dev/stdin is the invocation's own stdin and `-`
        # is a file named `-`.
        if is_stdin(path, dash=False):
            return await materialize(read_input(path))
        if dispatch is None:
            return await materialize(stream(path))
        return await read_program_file("jq", path, dispatch)

    # jq reads its options before its program, so a refused option is
    # reported before an -f file is read.
    plan = await read_options(*option_tape(fl, texts), read_flag_file)
    if isinstance(plan, IOResult):
        return None, plan
    if isinstance(plan, bytes):
        return yield_bytes(plan), IOResult()
    options = plan.config
    program_file = plan.program
    if isinstance(program_file, PathSpec):
        try:
            data = await read_flag_file(program_file)
        except FS_ERRORS as exc:
            line, code = program_file_refusal("jq", program_file, exc)
            return None, IOResult(exit_code=code, stderr=line.encode())
        if b"\0" in data:
            return None, IOResult(
                exit_code=ERROR_SYSTEM,
                stderr=b"jq: program file contains NUL bytes\n",
            )
        expression = data.decode(errors="replace")
        origin: str | None = posixpath.dirname(program_file.virtual)
    else:
        expression = program_file
        origin = None if cwd is None else cwd.virtual
    env_text = json.dumps(dict(env or {}))
    zone = local_zone(env)
    operands = list(paths)
    names = [input_name(path) for path in operands]
    if not operands and stdin is not None:
        operands.append(PathSpec.from_str_path("/dev/stdin"))
        names.append(STDIN_NAME)
    try:
        # jq compiles its program before it opens a single input, so a
        # refusal is all it prints. mirage-rs words jq's refusals itself,
        # reading the program as typed, so its lines and columns are jq's.
        # The run compiles it again when it starts, so nothing is held
        # open for a stream no one reads.
        checked = open_stream(
            "jq",
            run_config(expression, options, env_text, zone, origin, names),
        )
        await close_stream(checked)
    except StreamRefusal as exc:
        if not COMPILE_REPORT.search(exc.message):
            raise
        return None, IOResult(
            exit_code=ERROR_COMPILE, stderr=f"{exc.message}\n".encode()
        )
    config = run_config(
        expression.strip(), options, env_text, zone, origin, names
    )
    # Each input opens when the loop first reads it, as jq opens its files
    # one after another, so -n never opens one its program does not read.
    inputs = JqInputs([read_input(path) for path in operands])
    io = IOResult()
    return run_outputs(config, inputs, io), io


__all__ = ["jq"]
