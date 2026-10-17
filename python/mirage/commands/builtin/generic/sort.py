from collections.abc import Awaitable, Callable, Mapping
from contextlib import aclosing
from dataclasses import asdict, dataclass
from enum import Enum

from mirage.commands.builtin.errors import SortKeyError
from mirage.commands.builtin.sort_keys import (
    KeyMods,
    SortConfig,
    build_config,
    parse_keydef,
    tab_byte,
)
from mirage.commands.builtin.utils.lines import record_separator
from mirage.commands.builtin.utils.stream import (
    stdin_stream,
)
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.argmatch import ArgmatchMatch, argmatch
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import argmatch_error
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.types import BadDescriptorError, FileTooLargeError
from mirage.io.cooperative import chunks
from mirage.io.spool import ByteSpool
from mirage.io.types import ByteSource, IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.rs import StreamRefusal, open_stream, run_stream
from mirage.rs.stream import OpenStream
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn
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
    Output paths are compared as typed, in both languages.

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
    tab: int | None = None
    for dest, value in fl.occurrences(
        "key", "output", "c", "C", "check", "field_separator"
    ):
        if dest == "field_separator" and isinstance(value, str):
            byte = tab_byte(value)
            if tab is not None and byte != tab:
                raise UsageError("sort: incompatible tabs")
            tab = byte
        elif dest == "key" and isinstance(value, str):
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


def _label(path: PathSpec | None) -> str:
    if path is None:
        return "-"
    return path.raw_path


def stream_config(
    cfg: SortConfig, zero_terminated: bool
) -> dict[str, JsonValue]:
    """The mirage-rs sort configuration every mode shares.

    Args:
        cfg (SortConfig): the comparison.
        zero_terminated (bool): ``-z``.
    """
    return {"compare": asdict(cfg), "zero_terminated": zero_terminated}


# A run is sorted once its records reach SORT_RUN_BYTES, each counting its
# length plus 64, and spooled; MERGE_FAN_IN runs merge into one at a time,
# so a sort of any size holds one run and one chunk per merged input.
SORT_RUN_BYTES = 8 * 1024 * 1024
MERGE_FAN_IN = 16


async def _merge_spools(
    runs: list[ByteSpool], config: Mapping[str, JsonValue]
) -> ByteSpool:
    """A k-way merge of sorted spools, each read as the merge asks.

    Args:
        runs (list[ByteSpool]): the runs, closed once merged.
        config (Mapping[str, JsonValue]): ``stream_config``'s.
    """
    output = ByteSpool()
    readers = [chunks(run.stream()) for run in runs]
    budget = YieldBudget()

    # A call merges a bounded amount and leaves the stream busy with the
    # rest, so the loop yields between steps.
    async def add(produced: bytes) -> None:
        if produced:
            await output.append(produced)
        while stream.busy():
            if piece := stream.drain():
                await output.append(piece)
            await budget.run()
        await budget.run()

    try:
        stream = open_stream(
            "sort", {**config, "mode": "merge", "inputs": len(runs)}
        )
        while (index := stream.wants()) is not None:
            chunk = await anext(readers[index], None)
            await add(
                stream.end_input(index)
                if chunk is None
                else stream.feed_input(index, chunk)
            )
        await add(stream.finish())
        return output
    except BaseException:
        await output.close()
        raise
    finally:
        for reader in readers:
            await reader.aclose()
        for run in runs:
            await run.close()


async def _external_records(
    paths: list[PathSpec],
    read: PolymorphicReadFn,
    stdin: ByteSource | None,
    parsed: SortFlags,
    cfg: SortConfig,
) -> ByteSpool | bytes:
    separator = record_separator(parsed.zero_terminated)
    config = stream_config(cfg, parsed.zero_terminated)
    levels: list[list[ByteSpool]] = [[]]
    refused: tuple[InputStage, bytes] | None = None
    stream = stdin_stream(read, stdin)
    sorter = (
        None
        if parsed.merge
        else open_stream(
            "sort", {**config, "mode": "sort", "run_bytes": SORT_RUN_BYTES}
        )
    )
    merges = 0
    budget = YieldBudget()

    async def add_run(run: ByteSpool) -> None:
        nonlocal merges
        level = 0
        while True:
            if level == len(levels):
                levels.append([])
            levels[level].append(run)
            if len(levels[level]) < MERGE_FAN_IN:
                return
            group, levels[level] = levels[level], []
            run = await _merge_spools(group, config)
            merges += 1
            level += 1

    async def add_sorted(stream: OpenStream) -> None:
        # While the stream is busy each drain is one bounded step of a run
        # and what it writes belongs to that run, so the loop yields between
        # steps; a feed of no bytes then starts a run already buffered.
        while stream.busy():
            run = ByteSpool()
            try:
                while stream.busy():
                    if piece := stream.drain():
                        await run.append(piece)
                    await budget.run()
                await add_run(run)
            except BaseException:
                await run.close()
                raise
            stream.feed(b"")

    try:
        for path in list(paths) if paths else [None]:
            source = stream(path) if path is not None else stdin or b""
            run = ByteSpool() if parsed.merge else None
            last = separator
            try:
                async with aclosing(chunks(source)) as bounded:
                    async for chunk in bounded:
                        if not chunk:
                            continue
                        last = chunk[-1:]
                        if run is not None:
                            await run.append(chunk)
                        elif sorter is not None:
                            sorter.feed(chunk)
                            await add_sorted(sorter)
                # Each input's last record ends at its end, as GNU reads it.
                if sorter is not None and last != separator:
                    sorter.feed(separator)
                    await add_sorted(sorter)
                if run is not None:
                    await add_run(run)
                    run = None
            except FS_ERRORS as exc:
                strerror = fs_strerror(exc) or str(exc)
                stage = input_stage(strerror, not parsed.merge)
                refused = _earliest(
                    refused,
                    stage,
                    sort_die(
                        _stage_verb(stage, False), _label(path), strerror
                    ),
                )
                if stage is InputStage.ACCESS:
                    break
            finally:
                if run is not None:
                    await run.close()
        if refused is not None:
            return refused[1]
        if sorter is not None:
            sorter.finish()
            await add_sorted(sorter)
        runs = [run for level in reversed(levels) for run in level]
        # Ownership remains in levels until each merge closes its inputs.
        while len(runs) > 1:
            next_runs = []
            for start in range(0, len(runs), MERGE_FAN_IN):
                merged_run = await _merge_spools(
                    runs[start : start + MERGE_FAN_IN], config
                )
                merges += 1
                levels.append([merged_run])
                next_runs.append(merged_run)
            runs = next_runs
        output = runs[0] if runs else ByteSpool()
        # A single -m input is still merged alone: -u's adjacent duplicates
        # go and a last record gets its separator; merged inputs had both.
        if parsed.merge and merges == 0:
            output = await _merge_spools([output], config)
        for level in levels:
            for run in level:
                if run is not output:
                    await run.close()
        levels.clear()
        return output
    finally:
        for level in levels:
            for run in level:
                await run.close()


async def _check_stream(
    source: ByteSource,
    path: PathSpec | None,
    parsed: SortFlags,
    cfg: SortConfig,
) -> IOResult:
    config = {**stream_config(cfg, parsed.zero_terminated), "mode": "check"}
    try:
        async with aclosing(run_stream("sort", config, source)) as checked:
            async for _ in checked:
                pass
    except StreamRefusal as disorder:
        # The refusal's message is the record's number, its output the
        # record, which GNU writes with its own terminator.
        error = None
        if not parsed.check_quiet:
            error = (
                f"sort: {_label(path)}:{disorder.message}: disorder: ".encode()
                + disorder.output
                + record_separator(parsed.zero_terminated)
            )
        return IOResult(stderr=error, exit_code=1)
    except FS_ERRORS as exc:
        strerror = fs_strerror(exc) or str(exc)
        stage = input_stage(strerror, False)
        return IOResult(
            stderr=sort_die(_stage_verb(stage, True), _label(path), strerror),
            exit_code=2,
        )
    return IOResult()


async def sort_generic(
    paths: list[PathSpec],
    *,
    read_bytes: PolymorphicReadFn,
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
    if parsed.check:
        path = paths[0] if paths else None
        source = (
            stdin_stream(read_bytes, stdin)(path)
            if path is not None
            else stdin or b""
        )
        return b"", await _check_stream(source, path, parsed, cfg)
    ordered = await _external_records(paths, read_bytes, stdin, parsed, cfg)
    if isinstance(ordered, bytes):
        return b"", IOResult(stderr=ordered, exit_code=2)

    if parsed.output is not None:
        if write_bytes is None:
            await ordered.close()
            return b"", IOResult(
                stderr=b"sort: output is not writable on this backend\n",
                exit_code=2,
            )
        try:
            await write_bytes(parsed.output, ordered.stream())
        except FS_ERRORS as exc:
            strerror = fs_strerror(exc) or str(exc)
            return b"", IOResult(
                stderr=sort_die(OPEN_FAILED, parsed.output.raw_path, strerror),
                exit_code=2,
            )
        finally:
            await ordered.close()
        return b"", IOResult()
    return await ordered.output(), IOResult()


__all__ = ["sort_generic"]
