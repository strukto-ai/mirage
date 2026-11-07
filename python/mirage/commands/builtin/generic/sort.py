from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Iterator,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass, replace
from enum import Enum

from mirage.commands.builtin.utils.files0 import listed_names
from mirage.commands.builtin.utils.lines import record_separator
from mirage.commands.builtin.utils.random_source import (
    RandomSource,
    RandomSourceError,
)
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    stdin_stream,
)
from mirage.commands.constants import ROOT_CWD
from mirage.commands.spec import SPECS
from mirage.commands.spec.constants import OPERAND
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import usage_hint
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.render import ZERO_LENGTH_NAME
from mirage.errors.types import BadDescriptorError, FileTooLargeError
from mirage.io.cooperative import chunks
from mirage.io.spool import IO_BUFFER_SIZE, ByteSpool
from mirage.io.types import ByteSource, IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.rs import StreamRefusal, open_stream, run_stream
from mirage.rs.scan import refused, scan
from mirage.rs.stream import OpenStream, chain_output, close_stream
from mirage.shell.bytes import encode_text
from mirage.types import JsonValue, LineFacts, PathSpec, PolymorphicReadFn
from mirage.utils.ids import IdSource, SystemIdSource
from mirage.utils.quote import shell_quote, shell_quote_always

# The options sort's grammar in mirage-rs reads.
GRAMMAR = (
    "reverse",
    "numeric_sort",
    "general_numeric_sort",
    "human_numeric_sort",
    "version_sort",
    "month_sort",
    "ignore_case",
    "dictionary_order",
    "ignore_nonprinting",
    "ignore_leading_blanks",
    "unique",
    "stable",
    "zero_terminated",
    "field_separator",
    "key",
    "output",
    "c",
    "C",
    "check",
    "random_sort",
    "random_source",
)

# The options naming a file whose word the scan compares as typed.
_WORDS = ("output", "random_source")

# The steps GNU sort names when a file fails it. GNU checks that every
# input is readable before it reads any (`cannot read`), opens the
# output and the one input -c reads (`open failed`), stats every input
# it is about to sort (`stat failed`), and only then reads (`read
# failed`).
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


def step_failure(verb: str, label: str, strerror: str) -> bytes:
    """GNU sort's line for a failed step: the step, the name, the errno.

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
    first_failure: tuple[InputStage, bytes] | None,
    stage: InputStage,
    line: bytes,
) -> tuple[InputStage, bytes]:
    if first_failure is None or stage.value < first_failure[0].value:
        return stage, line
    return first_failure


@dataclass(frozen=True, slots=True)
class SortFlags:
    config: dict[str, JsonValue]
    check: bool = False
    check_quiet: bool = False
    merge: bool = False
    output: PathSpec | None = None
    zero_terminated: bool = False
    random: bool = False


def _typed_options(
    fl: FlagView, paths: list[PathSpec]
) -> list[tuple[str, str]]:
    """sort's options in the order typed, then its operands.

    An output or a random source is the word typed, which GNU compares
    (STREQ), so ``-o ./out -o out`` names two outputs though they are
    one file, and a bare ``--check`` is ``-c``, apart from
    ``--check=``'s empty word. The tape holds each such file resolved,
    so its word comes from the path the line typed in the same place.

    Args:
        fl (FlagView): sort's flags.
        paths (list[PathSpec]): the operands.

    Raises:
        ValueError: the tape holds other words than the paths.
    """
    tape = fl.occurrences(*GRAMMAR)
    words: dict[str, Iterator[str]] = {}
    for option in _WORDS:
        named = fl.as_paths(option)
        if sum(name == option for name, _ in tape) != len(named):
            raise ValueError(
                f"sort's tape holds other {option} words than its "
                f"{len(named)} paths"
            )
        words[option] = iter(
            path.raw_path if path.raw_path is not None else path.virtual
            for path in named
        )
    typed: list[tuple[str, str]] = []
    for name, value in tape:
        if name in words:
            typed.append((name, next(words[name])))
        elif value is True:
            typed.append(("c" if name == "check" else name, ""))
        elif isinstance(value, str):
            typed.append((name, value))
    typed.extend((OPERAND, path.raw_path) for path in paths)
    return typed


def engine_config(values: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
    """The configuration a sort scan read, which every sort engine takes.

    Args:
        values (Mapping[str, JsonValue]): what ``scan("sort", ...)`` read.

    Raises:
        ValueError: the scan read no configuration.
    """
    config = values.get("config")
    if isinstance(config, dict) and isinstance(
        config.get("zero_terminated"), bool
    ):
        return config
    raise ValueError(f"sort's scan read no config: {values!r}")


def parse_flags(
    flags: Mapping[str, FlagValue], paths: list[PathSpec]
) -> SortFlags | IOResult:
    """Read sort's options and operands in mirage-rs, before any input.

    Args:
        flags (Mapping[str, FlagValue]): the dispatcher's flag bag.
        paths (list[PathSpec]): the operands.

    Returns:
        SortFlags | IOResult: what the options decide, or what GNU sort
            refuses first, exit 1 for a refused ``--check`` word and 2
            for the rest.

    Raises:
        ValueError: the scan read no configuration or check mode.
    """
    fl = FlagView(flags, spec=SPECS["sort"])
    try:
        values = scan("sort", _typed_options(fl, paths))
    except StreamRefusal as refusal:
        return refused(refusal)
    config = engine_config(values)
    check = values["check"]
    if check not in (None, "c", "C"):
        raise ValueError(f"sort's scan read no check mode: {check!r}")
    outputs = fl.as_paths("output")
    return SortFlags(
        config=config,
        check=check is not None,
        check_quiet=check == "C",
        merge=fl.as_bool("merge"),
        output=outputs[-1] if outputs else None,
        zero_terminated=config["zero_terminated"] is True,
        random=values.get("random") is True,
    )


def _refusal(line: str) -> IOResult:
    return IOResult(exit_code=2, stderr=encode_text(line + "\n"))


async def _listed(
    source: PathSpec,
    paths: list[PathSpec],
    stream: Callable[[PathSpec], AsyncIterator[bytes]],
    cwd: PathSpec,
) -> list[PathSpec] | IOResult:
    """The inputs a ``--files0-from`` list names, every one vetted before
    any is read, or what GNU sort refuses first.

    Args:
        source (PathSpec): the list, ``-`` for stdin.
        paths (list[PathSpec]): the operands, which the list excludes.
        stream (Callable[[PathSpec], AsyncIterator[bytes]]): the reader.
        cwd (PathSpec): where a relative name is resolved.
    """
    label = source.raw_path if source.raw_path is not None else source.virtual
    if paths:
        word = paths[0].raw_path or paths[0].virtual
        return _refusal(
            f"sort: extra operand {shell_quote_always(word)}\n"
            "file operands cannot be combined with --files0-from\n"
            + usage_hint("sort")
        )
    try:
        names = await listed_names(source, stream)
    except IsADirectoryError:
        return _refusal(
            f"sort: cannot read file names from {shell_quote_always(label)}"
        )
    except FS_ERRORS as exc:
        strerror = fs_strerror(exc) or str(exc)
        return IOResult(
            exit_code=2, stderr=step_failure(OPEN_FAILED, label, strerror)
        )
    if not names:
        return _refusal(f"sort: no input from {shell_quote_always(label)}")
    for run, name in enumerate(names):
        if name == "":
            return _refusal(
                f"sort: {shell_quote(label)}:{run + 1}: {ZERO_LENGTH_NAME}"
            )
        if name == "-" and is_stdin(source):
            return _refusal(
                "sort: when reading file names from stdin, "
                "no file name of '-' allowed"
            )
    return [PathSpec.from_str_path(name, cwd=cwd) for name in names]


async def _salted(
    config: dict[str, JsonValue],
    source: PathSpec | None,
    stream: Callable[[PathSpec], AsyncIterator[bytes]],
    ids: IdSource,
) -> dict[str, JsonValue] | IOResult:
    """The configuration with the salt ``-R`` hashes keys under: the
    first 16 bytes of ``--random-source``, or 16 random ones.

    Args:
        config (dict[str, JsonValue]): the engine's, as mirage-rs read it.
        source (PathSpec | None): the ``--random-source`` file.
        stream (Callable[[PathSpec], AsyncIterator[bytes]]): its reader.
        ids (IdSource): the randomness without one.
    """
    if source is None:
        salt = ids.random_words(4)
    else:
        random = RandomSource("sort", source, stream, opening=OPEN_FAILED)
        try:
            salt = await random.take(16)
        except RandomSourceError as exc:
            return _refusal(str(exc))
        finally:
            await random.close()
    compare = config["compare"]
    if not isinstance(compare, dict):
        raise ValueError(f"sort's scan read no compare: {config!r}")
    return {**config, "compare": {**compare, "salt": list(salt)}}


def _label(path: PathSpec | None) -> str:
    if path is None:
        return "-"
    return path.raw_path


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
        config (Mapping[str, JsonValue]): the engine's, as mirage-rs read it.
    """
    output = ByteSpool()
    stream = open_stream(
        "sort", {**config, "mode": "merge", "inputs": len(runs)}
    )
    try:
        await output.fill(
            chain_output(
                stream, [run.stream(piece=IO_BUFFER_SIZE) for run in runs]
            )
        )
        return output
    except BaseException:
        await output.close()
        raise
    finally:
        for run in runs:
            await run.close()


async def _add_run(
    levels: list[list[ByteSpool]],
    run: ByteSpool,
    config: Mapping[str, JsonValue],
) -> None:
    level = 0
    while True:
        if level == len(levels):
            levels.append([])
        levels[level].append(run)
        if len(levels[level]) < MERGE_FAN_IN:
            return
        group, levels[level] = levels[level], []
        run = await _merge_spools(group, config)
        level += 1


async def _merge_operands(
    paths: list[PathSpec],
    read: PolymorphicReadFn,
    stdin: ByteSource | None,
    config: Mapping[str, JsonValue],
) -> ByteSpool | bytes:
    stream = stdin_stream(read, stdin)
    first_failure: tuple[InputStage, bytes] | None = None
    levels: list[list[ByteSpool]] = [[]]

    async def source(path: PathSpec | None) -> AsyncIterator[bytes]:
        nonlocal first_failure
        try:
            async with aclosing(
                chunks(stream(path) if path is not None else stdin or b"")
            ) as parts:
                async for part in parts:
                    yield part
        except FS_ERRORS as exc:
            strerror = fs_strerror(exc) or str(exc)
            stage = input_stage(strerror, False)
            first_failure = _earliest(
                first_failure,
                stage,
                step_failure(
                    _stage_verb(stage, False), _label(path), strerror
                ),
            )

    try:
        operands = list(paths) if paths else [None]
        for start in range(0, len(operands), MERGE_FAN_IN):
            group = operands[start : start + MERGE_FAN_IN]
            engine = open_stream(
                "sort", {**config, "mode": "merge", "inputs": len(group)}
            )
            output = ByteSpool()
            try:
                await output.fill(
                    chain_output(engine, [source(path) for path in group])
                )
                await _add_run(levels, output, config)
            except BaseException:
                await output.close()
                raise
        if first_failure is not None:
            return first_failure[1]
        runs = [run for level in reversed(levels) for run in level]
        while len(runs) > 1:
            merging = runs[:MERGE_FAN_IN]
            merged = await _merge_spools(merging, config)
            levels.append([merged])
            runs[: len(merging)] = [merged]
        output = runs.pop()
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


async def _external_records(
    paths: list[PathSpec],
    read: PolymorphicReadFn,
    stdin: ByteSource | None,
    parsed: SortFlags,
) -> ByteSpool | bytes:
    separator = record_separator(parsed.zero_terminated)
    config = parsed.config
    if parsed.merge:
        return await _merge_operands(paths, read, stdin, config)
    levels: list[list[ByteSpool]] = [[]]
    first_failure: tuple[InputStage, bytes] | None = None
    stream = stdin_stream(read, stdin)
    sorter = open_stream(
        "sort", {**config, "mode": "sort", "run_bytes": SORT_RUN_BYTES}
    )
    budget = YieldBudget()

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
                await _add_run(levels, run, config)
            except BaseException:
                await run.close()
                raise
            stream.feed(b"")

    try:
        for path in list(paths) if paths else [None]:
            source = stream(path) if path is not None else stdin or b""
            last = separator
            try:
                async with aclosing(chunks(source)) as bounded:
                    async for chunk in bounded:
                        if not chunk:
                            continue
                        last = chunk[-1:]
                        sorter.feed(chunk)
                        await add_sorted(sorter)
                # Each input's last record ends at its end, as GNU reads it.
                if last != separator:
                    sorter.feed(separator)
                    await add_sorted(sorter)
            except FS_ERRORS as exc:
                strerror = fs_strerror(exc) or str(exc)
                stage = input_stage(strerror, True)
                first_failure = _earliest(
                    first_failure,
                    stage,
                    step_failure(
                        _stage_verb(stage, False), _label(path), strerror
                    ),
                )
                if stage is InputStage.ACCESS:
                    break
        if first_failure is not None:
            return first_failure[1]
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
                levels.append([merged_run])
                next_runs.append(merged_run)
            runs = next_runs
        output = runs[0] if runs else ByteSpool()
        for level in levels:
            for run in level:
                if run is not output:
                    await run.close()
        levels.clear()
        return output
    finally:
        await close_stream(sorter)
        for level in levels:
            for run in level:
                await run.close()


async def _check_stream(
    source: ByteSource,
    path: PathSpec | None,
    parsed: SortFlags,
) -> IOResult:
    config = {**parsed.config, "mode": "check"}
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
            stderr=step_failure(
                _stage_verb(stage, True), _label(path), strerror
            ),
            exit_code=2,
        )
    return IOResult()


async def sort_generic(
    paths: list[PathSpec],
    *,
    read: PolymorphicReadFn,
    write_bytes: Callable[..., Awaitable[None]] | None = None,
    stdin: ByteSource | None = None,
    flags: Mapping[str, FlagValue],
    cwd: PathSpec = ROOT_CWD,
    ids: IdSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """GNU sort over the given inputs.

    The refusals come in GNU's order: what mirage-rs refuses in the
    options and the operands, then the inputs, and last the output.
    Deliberate divergence: GNU opens ``-o`` before it reads any input and
    this writes it once every input has been read, so when an input fails
    only at its stat or its read (a directory), GNU reports an unopenable
    output first and leaves a new one behind empty, and this reports the
    input and writes nothing. An output is named by the word typed, as
    GNU echoes it.

    Args:
        paths (list[PathSpec]): the operands; none reads standard input.
        read (Callable): reads one operand's bytes.
        write_bytes (Callable | None): writes ``-o``'s file, or None where
            the backend cannot write.
        stdin (ByteSource | None): standard input.
        flags (Mapping[str, FlagValue]): the dispatcher's flag bag.
        cwd (PathSpec): where a ``--files0-from`` name is resolved.
        ids (IdSource | None): the randomness ``-R`` salts keys with
            when no ``--random-source`` names a file.
    """
    parsed = parse_flags(flags, paths)
    if isinstance(parsed, IOResult):
        return b"", parsed
    fl = FlagView(flags, spec=SPECS["sort"])
    listed = fl.as_path("files0_from")
    if listed is not None:
        named = await _listed(listed, paths, stdin_stream(read, stdin), cwd)
        if isinstance(named, IOResult):
            return b"", named
        paths = named
        parsed = parse_flags(flags, paths)
        if isinstance(parsed, IOResult):
            return b"", parsed
    if parsed.random:
        sources = fl.as_paths("random_source")
        salted = await _salted(
            parsed.config,
            sources[-1] if sources else None,
            stdin_stream(read, stdin),
            ids if ids is not None else SystemIdSource(),
        )
        if isinstance(salted, IOResult):
            return b"", salted
        parsed = replace(parsed, config=salted)
    if parsed.check:
        path = paths[0] if paths else None
        source = (
            stdin_stream(read, stdin)(path)
            if path is not None
            else stdin or b""
        )
        return b"", await _check_stream(source, path, parsed)
    ordered = await _external_records(paths, read, stdin, parsed)
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
            await write_bytes(
                parsed.output, ordered.stream(piece=IO_BUFFER_SIZE)
            )
        except FS_ERRORS as exc:
            strerror = fs_strerror(exc) or str(exc)
            return b"", IOResult(
                stderr=step_failure(
                    OPEN_FAILED, parsed.output.raw_path, strerror
                ),
                exit_code=2,
            )
        finally:
            await ordered.close()
        return b"", IOResult()
    return await ordered.output(), IOResult()


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A sort line writes only the file ``-o`` names.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    return LineFacts(writes=fl.raw("output") is not None)


__all__ = ["facts", "sort_generic"]
