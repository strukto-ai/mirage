import dataclasses
import re
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from typing import Any

from mirage.commands.builtin.generic.program import (
    program_file_refusal,
    read_program_file,
)
from mirage.commands.builtin.utils.stream import is_stdin, stdin_stream
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.constants import OPERAND, REFUSED
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.standard import help_page, version_line
from mirage.commands.spec.types import FlagValue
from mirage.core.jq import (
    args_text,
    decode_utf8,
    error_report,
    format_jq_output,
    halt_report,
    jq_check,
    jq_run_texts,
    load_failure,
    printable,
    read_texts,
    references_args,
    stream_reads,
    string_text,
    value_text,
)
from mirage.core.jq.errors import JqCompileError
from mirage.core.jq.stream import InputReader
from mirage.core.jq.types import (
    DEFAULT_INDENT,
    NO_VALUE,
    STDIN_NAME,
    InputSource,
    JqError,
    JqHalt,
    JqOptions,
    JqParseError,
    JqRun,
    StreamReads,
)
from mirage.errors.constants import FS_ERRORS
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec

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

# What jq's process() answers for one run, which its exit status is made
# of (main.c): the last output was not false or null, it was, there was
# none, and an error no `try` caught ended the run.
OK = 0
OK_NULL_KIND = -1
OK_NO_OUTPUT = -4
ERROR_UNKNOWN = 5

# The outputs -e counts as null-kind, as jq dumps them.
NULL_KIND = frozenset(("null", "false"))

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


def positional_value(mode: str, word: str) -> str:
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
    text = value_text(word.encode())
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
        text = value_text(value.encode())
        if text is NO_VALUE:
            raise UsageError(
                f"jq: invalid JSON text passed to --argjson\n{USAGE_HINT}", 2
            )
        return text
    data = await _load_file(read_file, dest, name, value)
    if dest == "rawfile":
        return string_text(decode_utf8(data))
    shown = flag_file_name(value)
    texts, failure = await read_texts(InputSource(shown, yield_bytes(data)))
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
                    positional.append(positional_value(mode, word))
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
        positional.extend(positional_value(mode, word) for word in words)
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


def run_status(run: JqRun[str]) -> int:
    """What jq's process() answers for one run.

    Args:
        run (JqRun[str]): the run, its outputs jq's compact dumps.
    """
    if isinstance(run.stop, JqHalt):
        return OK if run.stop.code is None else int(run.stop.code)
    if isinstance(run.stop, JqError):
        return ERROR_UNKNOWN
    if not run.outputs:
        return OK_NO_OUTPUT
    return OK_NULL_KIND if run.outputs[-1] in NULL_KIND else OK


def exit_code(statuses: Sequence[int], opts: JqOptions) -> int:
    """Exit status for the program run over the whole input, as jq's
    main loop settles it.

    Only the last run counts, even after one that failed, unless it
    printed nothing, when -e looks back to the last value any run
    printed. Without -e only a failure shows, and a halt's own code.

    Args:
        statuses (Sequence[int]): what each run answered (run_status).
        opts (JqOptions): resolved options.
    """
    ret = OK_NO_OUTPUT
    last_result = -1
    for status in statuses:
        ret = status
        if status <= 0 and status != OK_NO_OUTPUT:
            last_result = 0 if status == OK_NULL_KIND else 1
    if not opts.exit_status:
        code = max(ret, 0)
    elif ret != OK_NO_OUTPUT:
        code = abs(ret)
    else:
        code = {-1: 4, 0: 1, 1: 0}[last_result]
    return code % 256


def parse_report(failure: JqParseError, opts: JqOptions) -> str:
    """jq's report of a parse error its main loop meets: fatal, or under
    --seq a line it prints before reading on.

    Args:
        failure (JqParseError): the error.
        opts (JqOptions): resolved options.
    """
    kind = "ignoring parse error" if opts.seq else "parse error"
    return f"jq: {kind}: {failure.message}\n"


class MainLoop:
    """jq's main loop (main.c) over an invocation's input stream.

    Each document runs as soon as the reader parses it, and its outputs
    stream out. A run's error is reported and the next document runs; a
    halt ends the loop; a parse error is reported with status 5 and ends
    it, except under --seq, which reports it and reads on. Under -n the
    program runs once, on null. The exit status and stderr settle on `io`
    once the stream is drained.

    A run of a program that calls `input` or `inputs` reads what they
    take before the program runs (see _run), and nothing past it, so the
    loop never reads further ahead than jq's own.

    An input that cannot be opened or read is reported when the reader
    reaches it, and the reader goes on to the next. The loop checks for
    such a failure before each document it reads, so it stops after the
    run of the document the failing read went on to, and the exit status
    is 2 whatever the runs answered.

    Args:
        sources (list[InputSource]): the inputs, in order, not yet opened.
        expr (str): jq program text.
        opts (JqOptions): resolved options.
        reads (StreamReads): which stream builtins the program calls.
        args (str | None): the value of `$ARGS`, as text.
        io (IOResult): the result to settle.
    """

    def __init__(
        self,
        sources: list[InputSource],
        expr: str,
        opts: JqOptions,
        reads: StreamReads,
        args: str | None,
        io: IOResult,
    ) -> None:
        self._reports: list[str] = []
        self._reader = InputReader(sources, opts, self._reports.append)
        self._expr = expr
        self._opts = opts
        self._reads = reads
        self._args = args
        self._io = io
        self._statuses: list[int] = []

    async def outputs(self) -> AsyncIterator[bytes]:
        """The invocation's stdout, run by run."""
        try:
            if self._opts.null_input:
                run, position = await self._run(
                    "null", self._reader.position()
                )
                if run.outputs:
                    yield format_jq_output(run.outputs, self._opts)
                self._settle(run, position)
                return
            while not self._reader.failures():
                item = await self._reader.next_input()
                if item is NO_VALUE:
                    return
                if isinstance(item, JqParseError):
                    self._fail(item)
                    if self._opts.seq:
                        continue
                    return
                run, position = await self._run(item, self._reader.position())
                if run.outputs:
                    yield format_jq_output(run.outputs, self._opts)
                if self._settle(run, position):
                    return
        finally:
            self._io.exit_code = (
                ERROR_SYSTEM
                if self._reader.failures()
                else exit_code(self._statuses, self._opts)
            )
            if self._reports:
                self._io.stderr = "".join(self._reports).encode()
            await self._reader.close()

    async def _run(self, doc: str, position: str) -> tuple[JqRun[str], str]:
        """Run the program on one document, and say where the reader
        stands after it, for its error report. The run is what jq's main
        loop gets to print (see printable).

        `input` and `inputs` consume the stream the main loop reads, so a
        run reads what they take first, and the next run starts past it.
        How much a run takes is a runtime fact libjq's Python binding does
        not report, so mirage assumes what the idioms do: `inputs` drains
        the rest (`[., inputs]`, `reduce inputs as $x`), and `input` alone
        takes one (`[., input]` pairs the documents up). A program that
        takes some other count (`first(inputs)`, an `input` in a branch
        not taken) leaves real jq a different remainder for its next run
        than here. A parse error stops the reading: the run raises it
        where `input` or `inputs` would reach it, and the main loop reads
        on past it.

        Args:
            doc (str): the run's own document, null under -n.
            position (str): where the reader stood once it had read it.
        """
        reads = self._reads
        if not (reads.input or reads.inputs):
            run = jq_run_texts(
                doc, self._expr, self._opts.named_args, None, self._args
            )
            return printable(run, self._opts), position
        docs: list[str] = []
        failure: JqParseError | None = None
        while True:
            item = await self._reader.next_input()
            position = self._reader.position()
            if item is NO_VALUE:
                break
            if isinstance(item, JqParseError):
                failure = item
                break
            docs.append(item)
            if not reads.inputs:
                break
        run = jq_run_texts(
            doc,
            self._expr,
            self._opts.named_args,
            docs,
            self._args,
            None if failure is None else failure.message,
        )
        return printable(run, self._opts), position

    def _settle(self, run: JqRun[str], position: str) -> bool:
        # Fold one run into the invocation: its answer toward the exit
        # status, and its report when it stopped early. A halt ends the
        # invocation, which is what this answers.
        self._statuses.append(run_status(run))
        if isinstance(run.stop, JqError):
            self._reports.append(error_report(position, run.stop))
        elif isinstance(run.stop, JqHalt):
            self._reports.append(halt_report(run.stop))
            return True
        return False

    def _fail(self, failure: JqParseError) -> None:
        # jq's `ret = JQ_ERROR_UNKNOWN; break`, or under --seq a report
        # that leaves the status alone.
        self._reports.append(parse_report(failure, self._opts))
        if not self._opts.seq:
            self._statuses.append(ERROR_UNKNOWN)


async def jq_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
) -> tuple[ByteSource | None, IOResult]:
    """Full-command jq entry; mirrors jqGeneric's (paths, texts, opts).

    The dispatcher-facing seam, so the builder stays wiring. It hands the
    flag bag on whole: the bag records the order the flags were typed in,
    which read_options reads and keywords would lose.
    """
    return await _jq(
        paths,
        texts,
        opts.flags,
        read_bytes,
        read_stream,
        opts.stdin,
        opts.dispatch,
    )


async def jq(
    paths: list[PathSpec],
    *texts: str,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    dispatch: DispatchFn | None = None,
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    """jq over keyword flags, the historical shape; keywords keep no record
    of the order they were typed in (see jq_generic)."""
    return await _jq(
        paths, texts, flags, read_bytes, read_stream, stdin, dispatch
    )


async def _jq(
    paths: list[PathSpec],
    texts: Sequence[str],
    flags: Mapping[str, FlagValue],
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None,
    dispatch: DispatchFn | None,
) -> tuple[ByteSource | None, IOResult]:
    """Run one jq invocation.

    Args:
        paths (list[PathSpec]): the input operands.
        texts (Sequence[str]): the text operands, program first unless -f
            gave it.
        flags (Mapping[str, FlagValue]): the flag bag.
        read_bytes (Callable): byte reader for one path.
        read_stream (Callable): chunk reader for one path.
        stdin (ByteSource | None): the invocation's stdin.
        dispatch (DispatchFn | None): the dispatcher a flag's file is read
            through.
    """
    fl = FlagView(flags, spec=SPECS["jq"])
    read_input = stdin_stream(read_stream, stdin)

    async def read_flag_file(path: PathSpec) -> bytes:
        # -f, --rawfile and --slurpfile route nothing (the executor's
        # FILE_KEYS and DISPATCH_FLAG_KEYS), so the file may sit on another
        # mount than the operands: it is read through the dispatcher. jq opens
        # it by name, so /dev/stdin is the invocation's own stdin and `-`
        # is a file named `-`.
        if is_stdin(path, dash=False):
            return await materialize(read_input(path))
        if dispatch is None:
            return await read_bytes(path)
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
    else:
        # jq defaults the filter to "." when no expression is given.
        expression = texts[0] if texts else "."
    expr = expression.strip()
    reads = stream_reads(expr)
    reads_stream = reads.input or reads.inputs
    args = args_text(opts) if references_args(expr) else None
    try:
        jq_check(expr, opts.named_args, [] if reads_stream else None, args)
    except JqCompileError as exc:
        # jq compiles its program before it opens a single input, so a
        # refusal is all it prints.
        return None, IOResult(
            exit_code=ERROR_COMPILE, stderr=f"{exc}\n".encode()
        )

    sources: list[InputSource] = []
    # -n does not read its inputs at all unless the program asks for them
    # through `input` or `inputs`, which is why jq -n never opens a
    # missing file. Each input is opened when the reader reaches it, as
    # jq opens its files one after another.
    if not opts.null_input or reads_stream:
        if paths:
            for path in paths:
                sources.append(InputSource(input_name(path), read_input(path)))
        elif stdin is not None:
            sources.append(
                InputSource(
                    STDIN_NAME,
                    read_input(PathSpec.from_str_path("/dev/stdin")),
                )
            )
    io = IOResult()
    loop = MainLoop(sources, expr, opts, reads, args, io)
    return loop.outputs(), io


__all__ = ["jq"]
