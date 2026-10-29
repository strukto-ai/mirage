# The option loop, main loop and exit statuses follow jq 1.8.2's
# src/main.c (MIT; see licenses/third_party/jq.txt).

import dataclasses
import json
import logging
import posixpath
import re
import time
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from typing import Any

from mirage.commands.builtin.generic.program import (
    program_file_refusal,
    read_program_file,
)
from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.builtin.utils.stream import is_stdin, stdin_stream
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.constants import OPERAND, REFUSED
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.standard import help_page, version_line
from mirage.commands.spec.types import FlagValue
from mirage.core.jq import (
    decode_utf8,
    load_failure,
    local_zone,
    read_texts,
    string_text,
    value_text,
)
from mirage.core.jq.eval import COMPILE_REPORT
from mirage.core.jq.types import (
    DEFAULT_INDENT,
    NO_VALUE,
    STDIN_NAME,
    JqOptions,
)
from mirage.errors.constants import FS_ERRORS, READ_FAILURES
from mirage.errors.fs import fs_strerror
from mirage.io.cooperative import chunks
from mirage.io.errors import MemoryExhausted
from mirage.io.memory import memory_room
from mirage.io.spool import ByteSpool
from mirage.io.stream import close_quietly, yield_bytes
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import (
    Served,
    close_stream,
    open_stream,
    serve_requests,
)
from mirage.runtime.types import DispatchFn
from mirage.types import JsonValue, PathSpec, ReadStreamFn

logger = logging.getLogger(__name__)

INDENT_MIN = -1
INDENT_MAX = 7
# A width in jq's range has at most one significant digit; the sign and
# leading zeroes keep strtol's decimal spelling without a large conversion.
INDENT_WORD = re.compile(r"([+-]?)0*([0-7])")

# The options whose order decides what they do: the layout options, which
# reset one another, the bindings, where the first of a name wins, and the
# modes, which file the operands typed after them.
LAYOUT = ("compact_output", "tab", "indent")
BINDINGS = ("arg", "argjson", "rawfile", "slurpfile")
MODES = ("args", "jsonargs")
# The options jq answers where its loop reaches them, and then exits.
STANDARD = ("help", "version")

# jq's exit status when it refuses the program itself, and when it could
# not read one of its inputs, whatever the runs answered.
ERROR_COMPILE = 3
ERROR_SYSTEM = 2

USAGE_HINT = (
    "Use jq --help for help with command-line options,\n"
    "or see the jq manpage, or online docs at https://jqlang.org"
)

# What jq says for an option the line ends before the values of (main.c).
TAKES = {
    "--arg": "--arg takes two parameters (e.g. --arg varname value)",
    "--argjson": "--argjson takes two parameters (e.g. --argjson varname text)",
    "--rawfile": "--rawfile takes two parameters (e.g. --rawfile varname filename)",
    "--slurpfile": (
        "--slurpfile takes two parameters (e.g. --slurpfile varname filename)"
    ),
    "--indent": "--indent takes one parameter",
}

# jq's -f is a switch that makes the program operand a file, so an -f the
# line ends at leaves jq no program, and it prints usage(2, 1), its short
# usage, to stderr.
SHORT_USAGE = (
    "jq - commandline JSON processor [version 1.8.2]\n\n"
    "Usage:\tjq [options] <jq filter> [file...]\n"
    "\tjq [options] --args <jq filter> [strings...]\n"
    "\tjq [options] --jsonargs <jq filter> [JSON_TEXTS...]\n\n"
    "jq is a tool for processing JSON inputs, applying the given filter to\n"
    "its JSON text inputs and producing the filter's results as JSON on\n"
    "standard output.\n\n"
    "The simplest filter is ., which copies jq's input to its output\n"
    "unmodified except for formatting. For more advanced filters see\n"
    'the jq(1) manpage ("man jq") and/or https://jqlang.org/.\n\n'
    "Example:\n\n"
    "\t$ echo '{\"foo\": 0}' | jq .\n"
    "\t{\n"
    '\t  "foo": 0\n'
    "\t}\n\n"
    "For listing the command options, use jq --help."
)


def _pair_args(values: Sequence[Any]) -> list[tuple[str, Any]]:
    """Read a pair option's flattened values back as (name, value).

    Args:
        values (Sequence[Any]): the accumulated tokens, name then value.
            A "path" pair (--rawfile, --slurpfile) carries a PathSpec in
            every value slot.
    """
    return [
        (str(values[i]), values[i + 1]) for i in range(0, len(values) - 1, 2)
    ]


def _pair_flag(fl: FlagView, name: str) -> list[tuple[str, Any]]:
    """Pairs recorded for one pair option, whatever their value type.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        name (str): the option's kwarg name.
    """
    raw = fl.raw(name)
    return _pair_args(raw) if isinstance(raw, list) else []


async def positional_value(mode: str, word: str) -> str:
    """The JSON text one operand gives `$ARGS.positional`: the string it
    spells after --args, and after --jsonargs the one JSON value it spells.

    Args:
        mode (str): the last of "args" and "jsonargs" typed before it.
        word (str): the operand.

    Raises:
        UsageError: when a --jsonargs value is not one JSON value, as
            jq's own parser reads it.
    """
    if mode == "args":
        return string_text(word)
    text = await value_text(word.encode())
    if text is NO_VALUE:
        raise UsageError(
            f"jq: invalid JSON text passed to --jsonargs\n{USAGE_HINT}", 2
        )
    return text


def option_refusal(word: str) -> UsageError:
    """jq's refusal of one option its loop cannot take.

    Args:
        word (str): the option as the parser left it on the tape: a word
            jq does not know, or an option the line ends before the
            values of.
    """
    if word in ("-f", "--from-file"):
        return UsageError(SHORT_USAGE, 2)
    line = TAKES.get(word, f"Unknown option {word}")
    return UsageError(f"jq: {line}\n{USAGE_HINT}", 2)


async def _binding(
    dest: str,
    name: str,
    value: str | PathSpec,
    read_file: Callable[..., Awaitable[bytes]],
) -> str:
    """The JSON text one binding gives its name: --arg a string,
    --argjson one JSON value, --rawfile a file's text, and --slurpfile the
    array of documents in a file, which is the same difference -R draws
    on the input stream. Both files are read the way jq reads its inputs.

    Args:
        dest (str): the option's kwarg name.
        name (str): the name it binds.
        value (str | PathSpec): the word --arg or --argjson binds, or the
            file --rawfile or --slurpfile reads.
        read_file (Callable): byte reader for one path.

    Raises:
        UsageError: an --argjson value that is not one JSON value as jq's
            own parser reads it, a file that cannot be read, and a
            --slurpfile holding bad JSON, in jq's words.
    """
    if isinstance(value, str):
        if dest == "arg":
            return string_text(value)
        text = await value_text(value.encode())
        if text is NO_VALUE:
            raise UsageError(
                f"jq: invalid JSON text passed to --argjson\n{USAGE_HINT}", 2
            )
        return text
    data = await _load_file(read_file, dest, name, value)
    if dest == "rawfile":
        return string_text(await decode_utf8(data))
    shown = flag_file_name(value)
    texts, failure = await read_texts(data)
    if failure is not None:
        raise UsageError(
            f"jq: Bad JSON in --slurpfile {name} {shown}: {failure.message}",
            ERROR_SYSTEM,
        )
    return f"[{','.join(texts)}]"


async def _load_file(
    read_bytes: Callable[..., Awaitable[bytes]],
    option: str,
    name: str,
    path: PathSpec,
) -> bytes:
    """One --rawfile or --slurpfile file's bytes.

    Args:
        read_bytes (Callable): byte reader for one path.
        option (str): the option, without its dashes.
        name (str): the variable it binds.
        path (PathSpec): the file.

    Raises:
        UsageError: when the file cannot be read, which jq words as bad
            JSON too.
    """
    try:
        data: bytes = await read_bytes(path)
    except FS_ERRORS as exc:
        shown = flag_file_name(path)
        raise UsageError(
            f"jq: Bad JSON in --{option} {name} {shown}: "
            f"{load_failure(shown, exc)}",
            ERROR_SYSTEM,
        ) from exc
    return data


def indent_width(word: str) -> int:
    """The width an --indent word names, read as jq 1.8.2's strtol reads
    it: a sign and decimal digits and nothing else, no blank before and no
    text after, from -1 to 7. Only the significant digit is converted,
    so arbitrary-length words never reach Python's integer digit limit.

    Args:
        word (str): the word typed after --indent.

    Raises:
        UsageError: for any other word, in jq's words.
    """
    match = INDENT_WORD.fullmatch(word)
    width = (
        int(match[2]) * (-1 if match[1] == "-" else 1)
        if match is not None
        else INDENT_MAX + 1
    )
    if not INDENT_MIN <= width <= INDENT_MAX:
        raise UsageError(
            f"jq: --indent takes a number between {INDENT_MIN} and "
            f"{INDENT_MAX}\n{USAGE_HINT}",
            2,
        )
    return width


def parse_flags(fl: FlagView) -> JqOptions:
    """Read the jq flags whose order does not matter into a frozen struct:
    the layout stays jq's default and nothing is bound, which read_options
    reads in the order typed.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    join_output = fl.as_bool("join_output")
    nul_output = fl.as_bool("raw_output0")
    return JqOptions(
        null_input=fl.as_bool("null_input"),
        raw_input=fl.as_bool("raw_input"),
        slurp=fl.as_bool("slurp"),
        stream=fl.as_bool("stream"),
        seq=fl.as_bool("seq"),
        # -j and --raw-output0 are -r plus a different separator.
        raw_output=fl.as_bool("raw_output") or join_output or nul_output,
        join_output=join_output,
        nul_output=nul_output,
        ascii_output=fl.as_bool("ascii_output"),
        sort_keys=fl.as_bool("sort_keys"),
        exit_status=fl.as_bool("exit_status"),
    )


async def read_options(
    fl: FlagView,
    texts: Sequence[str],
    has_program_file: bool,
    read_file: Callable[..., Awaitable[bytes]],
) -> JqOptions | bytes:
    """Read the jq flags, and the operands --args and --jsonargs file,
    into a frozen struct the way jq's option loop (main.c) reads them:
    one word at a time, in the order typed.

    The layout options reset one another, so the last of ``-c``,
    ``--tab`` and ``--indent`` decides (``--indent -1`` is ``--tab``). A
    binding takes its name only while the name is free: the first
    ``--arg``, ``--argjson``, ``--rawfile`` or ``--slurpfile`` of a name
    wins, as ``$name`` and in ``$ARGS.named``, which lists the names in
    the order they were bound. A later binding of the name is never read,
    so its JSON is not parsed and its file is not opened. The program is
    the first operand, whatever the mode. Every operand after it is filed
    by the last of ``--args`` and ``--jsonargs`` typed before it: a
    string, or one JSON value parsed right then. One typed before either
    is an input file, which the parser left a path. An option jq refuses
    stops the loop where it stands, so the refusal reported is the first
    one typed, a ``--jsonargs`` operand's included, and ``--help`` or
    ``--version`` answers in place of the options when the loop reaches it
    first. Operands the bag has no tape for (keyword flags) come after
    every option.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        texts (Sequence[str]): text operands, program included unless it
            came from a file.
        has_program_file (bool): whether -f supplied the program, which
            frees the first text slot.
        read_file (Callable): byte reader for a --rawfile or --slurpfile.

    Returns:
        JqOptions | bytes: the options, or what --help or --version
            prints.

    Raises:
        UsageError: an option the parser refused (option_refusal), an
            --indent word indent_width refuses, a --jsonargs operand
            positional_value refuses, and the refusals of a binding (see
            _binding), in jq's words.
    """
    compact, tab, indent = False, False, DEFAULT_INDENT
    named: dict[str, str] = {}
    positional: list[str] = []
    mode: str | None = None
    program = not has_program_file
    words = iter(texts[1:] if program else texts)
    pairs = {dest: iter(_pair_flag(fl, dest)) for dest in BINDINGS}
    tape = iter(
        fl.occurrences(*LAYOUT, *BINDINGS, *MODES, *STANDARD, OPERAND, REFUSED)
    )
    for dest, value in tape:
        if dest == REFUSED:
            raise option_refusal(str(value))
        if dest in STANDARD:
            return (
                help_page("jq", SPECS["jq"])
                if dest == "help"
                else version_line("jq")
            )
        if dest == OPERAND:
            if program:
                program = False
            elif mode is not None:
                word = next(words, None)
                if word is not None:
                    positional.append(await positional_value(mode, word))
        elif dest in MODES:
            mode = dest
        elif dest == "compact_output":
            compact, tab = True, False
        elif dest == "tab":
            compact, tab = False, True
        elif dest == "indent":
            width = indent_width(str(value))
            compact, tab = False, width == INDENT_MIN
            indent = DEFAULT_INDENT if tab else width
        else:
            # A binding is two words on the tape, its name and what it
            # binds, and the bag keeps each pair as typed.
            next(tape, None)
            pair = next(pairs[dest], None)
            if pair is None:
                continue
            name, bound = pair
            if name not in named:
                named[name] = await _binding(dest, name, bound, read_file)
    if mode is not None:
        positional.extend(
            [await positional_value(mode, word) for word in words]
        )
    return dataclasses.replace(
        parse_flags(fl),
        compact=compact,
        tab=tab,
        indent=indent,
        named_args=named,
        positional_args=tuple(positional),
    )


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
    opts: JqOptions,
    env: str,
    zone: str | None,
    origin: str | None,
    inputs: Sequence[str],
) -> dict[str, JsonValue]:
    """What mirage-rs's jq takes for one invocation.

    Args:
        expr (str): jq program text.
        opts (JqOptions): resolved options.
        env (str): the environment `$ENV` and `env` read, as text.
        zone (str | None): the `TZ` local time reads (local_zone).
        origin (str | None): the directory `get_prog_origin` answers.
        inputs (Sequence[str]): the inputs' names as jq reports them.
    """
    limit = memory_room()
    return {
        "program": expr,
        "named": [[name, text] for name, text in opts.named_args.items()],
        "positional": list(opts.positional_args),
        "env": env,
        "zone": zone,
        "prog_origin": origin,
        **({} if limit is None else {"memory": limit}),
        "inputs": list(inputs),
        "null_input": opts.null_input,
        "raw_input": opts.raw_input,
        "slurp": opts.slurp,
        "stream": opts.stream,
        "seq": opts.seq,
        "exit_status": opts.exit_status,
        "raw_output": opts.raw_output,
        "join_output": opts.join_output,
        "nul_output": opts.nul_output,
        "ascii_output": opts.ascii_output,
        "sort_keys": opts.sort_keys,
        "compact": opts.compact,
        "tab": opts.tab,
        "indent": opts.indent,
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
        io.exit_code = stream.status()
        await inputs.errors.append(stream.take_stderr())
        io.stderr = await inputs.errors.output()
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

    program_file = fl.raw("from_file")
    # jq reads its options before its program, so a refused option is
    # reported before an -f file is read.
    opts = await read_options(
        fl, texts, isinstance(program_file, PathSpec), read_flag_file
    )
    if isinstance(opts, bytes):
        return yield_bytes(opts), IOResult()
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
        # jq defaults the filter to "." when no expression is given.
        expression = texts[0] if texts else "."
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
            "jq", run_config(expression, opts, env_text, zone, origin, names)
        )
        await close_stream(checked)
    except StreamRefusal as exc:
        if not COMPILE_REPORT.search(exc.message):
            raise
        return None, IOResult(
            exit_code=ERROR_COMPILE, stderr=f"{exc.message}\n".encode()
        )
    config = run_config(
        expression.strip(), opts, env_text, zone, origin, names
    )
    # Each input opens when the loop first reads it, as jq opens its files
    # one after another, so -n never opens one its program does not read.
    inputs = JqInputs([read_input(path) for path in operands])
    io = IOResult()
    return run_outputs(config, inputs, io), io


__all__ = ["jq"]
