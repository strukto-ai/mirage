from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from enum import Enum

from mirage.commands.builtin.errors import SortKeyError
from mirage.commands.builtin.sort_keys import (
    KeyMods,
    SortConfig,
    build_config,
    compare_lines,
    merge_lines,
    parse_keydef,
    sort_lines,
)
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import read_stdin_async, stdin_bytes
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.argmatch import ArgmatchMatch, argmatch
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import argmatch_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import (
    FS_ERRORS,
    BadDescriptorError,
    FileTooLargeError,
    fs_strerror,
)
from mirage.utils.quote import shell_quote

# `check_args` as gnulib's `argmatch_valid` prints it: `quiet` and
# `silent` map to the same value, so they share one `  - ` line.
CHECK_ARGS = (("quiet", "silent"), ("diagnose-first",))

MULTIPLE_OUTPUTS = "sort: multiple output files specified"

CHECK_MODES_CONFLICT = "sort: options '-cC' are incompatible"

# sort.c's `sort_die` prefixes. GNU tests every input with
# euidaccess(R_OK) before it reads any (`cannot read`), opens the output
# and the one input -c reads with open(2) (`open failed`), stats every
# input it is about to sort to size its buffer (`stat failed`), and only
# then reads (`read failed`).
CANNOT_READ = "cannot read"
OPEN_FAILED = "open failed"
STAT_FAILED = "stat failed"
READ_FAILED = "read failed"


class InputStage(Enum):
    """The step at which GNU sort first meets an input's failure.

    Declared in the order GNU takes the steps, so the value is also the
    precedence: sort runs every input through one step before it moves
    any of them to the next, and a missing second input is reported
    ahead of an unreadable first one.
    """

    ACCESS = 0
    STAT = 1
    READ = 2


def input_stage(strerror: str, sorting: bool) -> InputStage:
    """Which step an input failure belongs to, told by its strerror.

    euidaccess(R_OK) passes a directory, so GNU meets one only when the
    read of it fails, and a mount's record cap refuses the same way. A
    closed standard input fails the fstat plain sort takes of every input
    before reading, but ``-m`` and ``-c`` never stat and fail on the read
    instead. Classified by the strerror a renderer wrote, so the stream
    path, which only holds a rendered line, sorts a failure into the same
    step as a command holding the exception.

    Args:
        strerror (str): the failure's GNU strerror text.
        sorting (bool): the run sorts, rather than merging or checking.
    """
    if strerror == fs_strerror(BadDescriptorError()):
        return InputStage.STAT if sorting else InputStage.READ
    for exc_type in (IsADirectoryError, FileTooLargeError):
        if strerror == fs_strerror(exc_type()):
            return InputStage.READ
    return InputStage.ACCESS


def sort_die(verb: str, label: str, strerror: str) -> bytes:
    """GNU's ``sort_die`` line: the step, the name, then the errno.

    Args:
        verb (str): which step failed (``CANNOT_READ``, ``OPEN_FAILED``,
            ``STAT_FAILED`` or ``READ_FAILED``).
        label (str): the file, spelled for the diagnostic.
        strerror (str): the failure's GNU strerror text.
    """
    return f"sort: {verb}: {shell_quote(label)}: {strerror}\n".encode()


def _stage_verb(stage: InputStage, checking: bool) -> str:
    if stage is InputStage.READ:
        return READ_FAILED
    if stage is InputStage.STAT:
        return STAT_FAILED
    return OPEN_FAILED if checking else CANNOT_READ


def _earliest(
    refused: tuple[InputStage, bytes] | None, stage: InputStage, line: bytes
) -> tuple[InputStage, bytes]:
    if refused is None or stage.value < refused[0].value:
        return stage, line
    return refused


@dataclass(frozen=True, slots=True)
class SortFlags:
    reverse: bool = False
    numeric: bool = False
    unique: bool = False
    fold_case: bool = False
    key_defs: tuple[str, ...] = ()
    field_separator: str | None = None
    human_numeric: bool = False
    version_sort: bool = False
    month_sort: bool = False
    ignore_blanks: bool = False
    stable: bool = False
    check: bool = False
    check_quiet: bool = False
    dictionary: bool = False
    general_numeric: bool = False
    ignore_nonprinting: bool = False
    merge: bool = False
    output: PathSpec | None = None
    zero_terminated: bool = False


def _check_mode(raw: FlagValue, dest: str) -> str:
    """The check mode one check option asks for, as GNU's letter.

    ``-c``, a bare ``--check`` and ``--check=diagnose-first`` are ``c``;
    ``-C`` and ``--check=quiet`` (or ``silent``) are ``C``.

    Args:
        raw (FlagValue): one check option's value.
        dest (str): ``c``, ``C`` or ``check``.

    Raises:
        UsageError: ``--check`` names no mode, which gnulib's argmatch
            refuses with exit 1.
    """
    if dest != "check":
        return dest
    if raw is True:
        return "c"
    word = str(raw)
    match = argmatch(word, CHECK_ARGS)
    if not isinstance(match, ArgmatchMatch):
        raise argmatch_error(
            "sort", "--check", word, CHECK_ARGS, 1, match.kind
        )
    # The canonical word of the ('quiet', 'silent') value is `quiet`, so
    # `--check=s` and `--check=silent` both land here.
    return "C" if match.word == "quiet" else "c"


def parse_flags(flags: Mapping[str, FlagValue]) -> SortFlags:
    """Read sort's flags once, refusing what GNU's option loop refuses.

    Each option is validated in its original scan order, including
    interleaved accumulating options and repeated scalar check modes.
    Output paths are compared after resolution in both languages.

    Args:
        flags (Mapping[str, FlagValue]): the dispatcher's flag bag.

    Raises:
        UsageError: a refused option, exit 1 for a ``--check`` word
            argmatch refuses and 2 for the rest.
        SortKeyError: a ``-k`` that is not a KEYDEF.
    """
    fl = FlagView(flags, spec=SPECS["sort"])
    mode: str | None = None
    output: PathSpec | None = None
    # Each -o is the next word typed, and GNU compares two by that word
    # (STREQ), so `-o ./out -o out` names two outputs even though they
    # are one file.
    typed = iter(fl.as_paths("output"))
    for dest, value in fl.occurrences("key", "output", "c", "C", "check"):
        if dest == "key" and isinstance(value, str):
            parse_keydef(value, KeyMods(), False)
        elif dest == "output":
            path = next(typed)
            if output is not None and path.raw_path != output.raw_path:
                raise UsageError(MULTIPLE_OUTPUTS)
            output = path
        elif dest == "check" or value is True:
            letter = _check_mode(value, dest)
            if mode is not None and letter != mode:
                raise UsageError(CHECK_MODES_CONFLICT)
            mode = letter
    return SortFlags(
        reverse=fl.as_bool("reverse"),
        numeric=fl.as_bool("numeric_sort"),
        unique=fl.as_bool("unique"),
        fold_case=fl.as_bool("ignore_case"),
        key_defs=tuple(fl.as_list("key")),
        field_separator=fl.as_str("field_separator"),
        human_numeric=fl.as_bool("human_numeric_sort"),
        version_sort=fl.as_bool("version_sort"),
        month_sort=fl.as_bool("month_sort"),
        ignore_blanks=fl.as_bool("ignore_leading_blanks"),
        stable=fl.as_bool("stable"),
        check=mode is not None,
        check_quiet=mode == "C",
        dictionary=fl.as_bool("dictionary_order"),
        general_numeric=fl.as_bool("general_numeric_sort"),
        ignore_nonprinting=fl.as_bool("ignore_nonprinting"),
        merge=fl.as_bool("merge"),
        output=output,
        zero_terminated=fl.as_bool("zero_terminated"),
    )


def _config(parsed: SortFlags) -> SortConfig:
    return build_config(
        key_defs=list(parsed.key_defs),
        field_sep=parsed.field_separator,
        reverse=parsed.reverse,
        numeric=parsed.numeric,
        unique=parsed.unique,
        fold_case=parsed.fold_case,
        human_numeric=parsed.human_numeric,
        version_sort=parsed.version_sort,
        month_sort=parsed.month_sort,
        ignore_blanks=parsed.ignore_blanks,
        stable=parsed.stable,
        general_numeric=parsed.general_numeric,
        dictionary=parsed.dictionary,
        ignore_nonprinting=parsed.ignore_nonprinting,
    )


def _refusal_of(exc: ValueError) -> IOResult:
    if isinstance(exc, UsageError):
        # Already GNU-worded and carrying its own code: gnulib's argmatch
        # dies with EXIT_FAILURE, so `--check=x` is 1 where sort's other
        # usage errors are 2.
        return IOResult(stderr=f"{exc}\n".encode(), exit_code=exc.exit_code)
    return IOResult(stderr=f"sort: {exc}\n".encode(), exit_code=2)


def operand_refusal(
    paths: list[PathSpec], parsed: SortFlags
) -> IOResult | None:
    """What ``-c`` refuses in its operands, which GNU checks before reading.

    A second operand outranks an ``-o``, and both name the check mode by
    its own letter, so ``sort -C a b`` is ``not allowed with -C``.

    Args:
        paths (list[PathSpec]): the operands.
        parsed (SortFlags): the parsed flags.
    """
    if not parsed.check:
        return None
    mode = "C" if parsed.check_quiet else "c"
    if len(paths) > 1:
        label = paths[1].raw_path
        return IOResult(
            stderr=(
                f"sort: extra operand '{label}' not allowed with -{mode}\n"
            ).encode(),
            exit_code=2,
        )
    if parsed.output is not None:
        return IOResult(
            stderr=f"sort: options '-{mode}o' are incompatible\n".encode(),
            exit_code=2,
        )
    return None


def _split_records(raw: bytes, zero_terminated: bool) -> list[str]:
    if not zero_terminated:
        return split_lines(raw.decode(errors="replace"))
    records = raw.split(b"\x00")
    if records and records[-1] == b"":
        records.pop()
    return [record.decode(errors="replace") for record in records]


def _label(path: PathSpec | None) -> str:
    if path is None:
        return "-"
    return path.raw_path


async def _read_runs(
    paths: list[PathSpec],
    read_bytes: Callable[[PathSpec], Awaitable[bytes]],
    stdin: ByteSource | None,
    parsed: SortFlags,
) -> list[list[str]] | bytes:
    """Every input's records, one run per input, or the line refusing one.

    Each input is split on its own, so a file that lacks a final newline
    still ends its last line there instead of running into the next
    file's first, and ``-m`` gets the runs it merges. GNU takes every
    input through one step before any through the next, so the failure
    reported is the first of the earliest step any input failed at: a
    directory does not stop the later inputs from being tried, and the
    first input to fail its access check ends the run, since nothing
    after it can outrank that.

    Args:
        paths (list[PathSpec]): the operands; none reads standard input.
        read_bytes (Callable): reads one operand, ``-`` included.
        stdin (ByteSource | None): standard input.
        parsed (SortFlags): the parsed flags.
    """
    sorting = not parsed.check and not parsed.merge
    runs: list[list[str]] = []
    refused: tuple[InputStage, bytes] | None = None
    inputs: list[PathSpec | None] = list(paths) if paths else [None]
    for path in inputs:
        try:
            if path is None:
                raw = await read_stdin_async(stdin) or b""
            else:
                raw = await read_bytes(path)
        except FS_ERRORS as exc:
            strerror = fs_strerror(exc) or str(exc)
            stage = input_stage(strerror, sorting)
            verb = _stage_verb(stage, parsed.check)
            refused = _earliest(
                refused, stage, sort_die(verb, _label(path), strerror)
            )
            if stage is InputStage.ACCESS:
                break
            continue
        runs.append(_split_records(raw, parsed.zero_terminated))
    if refused is not None:
        return refused[1]
    return runs


async def sort_generic(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]] | None = None,
    stdin: ByteSource | None = None,
    flags: Mapping[str, FlagValue] | None = None,
    reverse: bool = False,
    numeric: bool = False,
    unique: bool = False,
    fold_case: bool = False,
    key_defs: list[str] | None = None,
    field_separator: str | None = None,
    human_numeric: bool = False,
    version_sort: bool = False,
    month_sort: bool = False,
    ignore_blanks: bool = False,
    stable: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    """GNU sort over the given inputs.

    The refusals come in GNU's order: the option loop's, then with ``-c``
    a second operand and an ``-o``, then the inputs, and last the output.
    Deliberate divergence: GNU opens ``-o`` before it reads any input and
    this writes it once every input has been read, so when an input fails
    only at its stat or its read (a directory), GNU reports an unopenable
    output first and leaves a new one behind empty, and this reports the
    input and writes nothing. An output is named by the word typed, as
    GNU echoes it.

    Args:
        paths (list[PathSpec]): the operands; none reads standard input.
        read_bytes (Callable): reads one operand's bytes.
        write_bytes (Callable | None): writes ``-o``'s file, or None where
            the backend cannot write.
        stdin (ByteSource | None): standard input.
        flags (Mapping[str, FlagValue] | None): the dispatcher's flag bag;
            None takes the keyword options instead.
    """
    try:
        parsed = (
            parse_flags(flags)
            if flags is not None
            else SortFlags(
                reverse=reverse,
                numeric=numeric,
                unique=unique,
                fold_case=fold_case,
                key_defs=tuple(key_defs or ()),
                field_separator=field_separator,
                human_numeric=human_numeric,
                version_sort=version_sort,
                month_sort=month_sort,
                ignore_blanks=ignore_blanks,
                stable=stable,
            )
        )
        cfg = _config(parsed)
    except (UsageError, SortKeyError, ValueError) as exc:
        return b"", _refusal_of(exc)

    refusal = operand_refusal(paths, parsed)
    if refusal is not None:
        return b"", refusal
    runs = await _read_runs(
        paths, stdin_bytes(read_bytes, stdin), stdin, parsed
    )
    if isinstance(runs, bytes):
        return b"", IOResult(stderr=runs, exit_code=2)

    if parsed.check:
        records = runs[0]
        for index in range(1, len(records)):
            comparison = compare_lines(records[index - 1], records[index], cfg)
            if comparison > 0 or (parsed.unique and comparison == 0):
                if parsed.check_quiet:
                    return b"", IOResult(exit_code=1)
                label = _label(paths[0] if paths else None)
                error = (
                    f"sort: {label}:{index + 1}: disorder: {records[index]}\n"
                )
                return b"", IOResult(stderr=error.encode(), exit_code=1)
        return b"", IOResult()

    if parsed.merge:
        ordered = merge_lines(runs, cfg)
    else:
        ordered = sort_lines([record for run in runs for record in run], cfg)
    separator = b"\x00" if parsed.zero_terminated else b"\n"
    output = separator.join(record.encode() for record in ordered)
    if ordered:
        output += separator
    if parsed.output is not None:
        if write_bytes is None:
            return b"", IOResult(
                stderr=b"sort: output is not writable on this backend\n",
                exit_code=2,
            )
        try:
            await write_bytes(parsed.output, output)
        except FS_ERRORS as exc:
            strerror = fs_strerror(exc) or str(exc)
            return b"", IOResult(
                stderr=sort_die(OPEN_FAILED, parsed.output.raw_path, strerror),
                exit_code=2,
            )
        return b"", IOResult(
            writes={parsed.output.mount_path: output},
            cache=[parsed.output.mount_path],
        )
    return output, IOResult()


__all__ = ["sort_generic"]
