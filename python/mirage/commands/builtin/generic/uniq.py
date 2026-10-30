from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import split_readable
from mirage.commands.builtin.utils.stream import (
    resolve_source,
    stdin_stat,
    stdin_stream,
    stream_output,
)
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.constants import OPERAND
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import word_refusal_error
from mirage.commands.spec.word_choice import WordMatch, match_word
from mirage.io.spool import ByteSpool
from mirage.io.stream import close_quietly
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused
from mirage.rs.stream import open_stream
from mirage.shell.bytes import byte_view, encode_text
from mirage.types import JsonValue, PathSpec, StatFn

# The --all-repeated and --group words, in the order GNU lists each
# back. No aliases in either, so one candidate per line.
ALL_REPEATED_ARGS = ("none", "prepend", "separate")
GROUP_ARGS = ("prepend", "append", "separate", "both")


@dataclass(frozen=True, slots=True)
class UniqFlags:
    count: bool = False
    repeated: bool = False
    unique: bool = False
    typed: tuple[tuple[str, str], ...] = ()
    ignore_case: bool = False
    all_repeated: str | None = None
    group: str | None = None
    zero_terminated: bool = False


def _method_word(option: str, value: str, allowed: tuple[str, ...]) -> str:
    """One ``--group``/``--all-repeated`` word, an unambiguous prefix too.

    Args:
        option (str): the option's long spelling, for the refusal.
        value (str): the method word as typed.
        allowed (tuple[str, ...]): GNU's candidates in declaration
            order, one value each (neither option has aliases).
    """
    match = match_word(value, allowed)
    if not isinstance(match, WordMatch):
        raise word_refusal_error(
            "uniq", option, value, allowed, None, match.kind
        )
    return match.word


def parse_flags(
    flags: Mapping[str, FlagValue], operands: Sequence[str] = ()
) -> UniqFlags:
    fl = FlagView(flags, spec=SPECS["uniq"])
    typed = fl.texts(OPERAND, "skip_fields", "skip_chars", "check_chars")
    if all(name != OPERAND for name, _ in typed):
        typed += [(OPERAND, word) for word in operands]
    raw_all = fl.raw("all_repeated")
    all_repeated: str | None = None
    if fl.as_bool("D") or raw_all is True:
        all_repeated = "none"
    elif isinstance(raw_all, str):
        all_repeated = raw_all
    if all_repeated is not None:
        all_repeated = _method_word(
            "--all-repeated", all_repeated, ALL_REPEATED_ARGS
        )
    raw_group = fl.raw("group")
    group = "separate" if raw_group is True else raw_group
    if group is not None:
        group = _method_word("--group", str(group), GROUP_ARGS)
    return UniqFlags(
        count=fl.as_bool("count"),
        repeated=fl.as_bool("repeated"),
        unique=fl.as_bool("unique"),
        typed=tuple(typed),
        ignore_case=fl.as_bool("ignore_case"),
        all_repeated=all_repeated,
        group=group,
        zero_terminated=fl.as_bool("zero_terminated"),
    )


def _conflict(parsed: UniqFlags) -> str | None:
    """The options GNU uniq refuses together once it has read them all.

    Args:
        parsed (UniqFlags): the options.
    """
    if parsed.group is not None and (
        parsed.count
        or parsed.repeated
        or parsed.unique
        or parsed.all_repeated is not None
    ):
        return "uniq: --group is mutually exclusive with -c/-d/-D/-u"
    if parsed.count and parsed.all_repeated is not None:
        return (
            "uniq: printing all duplicated lines and repeat counts is "
            "meaningless"
        )
    return None


def uniq_flags(
    flags: Mapping[str, FlagValue], operands: Sequence[str] = ()
) -> UniqFlags | IOResult:
    """uniq's options, its counts and operands refused by the engine in
    the order typed, before any operand is read.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags, each operand's
            glob spread over its matches.
        operands (Sequence[str]): the operands as typed, glob matches in
            place; a call whose flags carry no tape reads them after
            every option.

    Returns:
        UniqFlags | IOResult: the flags, or uniq's refusal.
    """
    try:
        parsed = parse_flags(flags, operands)
    except UsageError as exc:
        return IOResult(
            exit_code=exc.exit_code, stderr=encode_text(str(exc) + "\n")
        )
    try:
        open_stream("uniq", engine_config(parsed))
    except StreamRefusal as refusal:
        return refused(refusal)
    conflict = _conflict(parsed)
    if conflict is not None:
        return IOResult(exit_code=1, stderr=encode_text(conflict + "\n"))
    return parsed


def engine_config(parsed: UniqFlags) -> dict[str, JsonValue]:
    """The uniq engine's config, the counts and operands as typed.

    Args:
        parsed (UniqFlags): the options.
    """
    config: dict[str, JsonValue] = {
        "count": parsed.count,
        "repeated": parsed.repeated,
        "unique": parsed.unique,
        "typed": [[name, byte_view(text)] for name, text in parsed.typed],
        "ignore_case": parsed.ignore_case,
        "all_repeated": parsed.all_repeated,
        "group": parsed.group,
        "zero_terminated": parsed.zero_terminated,
    }
    return config


async def uniq_generic(
    parsed: UniqFlags,
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]] | None = None,
    stdin: ByteSource | None = None,
    stat: StatFn | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run uniq over resolved operands, GNU semantics; mirrors uniqGeneric.

    Args:
        parsed (UniqFlags): the options, read before the operands were.
        paths (list[PathSpec]): INPUT and OUTPUT, glob-resolved.
        read_stream (Callable[..., AsyncIterator[bytes]]): bound reader.
        write_bytes (Callable[..., Awaitable[None]] | None): bound writer
            for OUTPUT.
        stdin (ByteSource | None): the line's input.
        stat (StatFn | None): bound stat.
    """
    read_stream = stdin_stream(read_stream, stdin)
    if paths and stat is not None:
        # The input is stat'ed before the lazy stream starts, so a missing
        # or unreadable one is reported in uniq's own words rather than
        # surfacing mid-drain.
        _, err = await split_readable(paths[:1], stdin_stat(stat), "uniq")
        if err:
            return None, IOResult(exit_code=1, stderr=err)
    if paths:
        source = read_stream(paths[0])
    else:
        source = resolve_source(stdin)
    output: ByteSource = stream_output(
        open_stream("uniq", engine_config(parsed)), source
    )
    if len(paths) == 2 and paths[1].raw_path != "-":
        if write_bytes is None:
            await close_quietly(output)
            return None, IOResult(
                exit_code=1, stderr=b"uniq: output is not writable\n"
            )
        # Consume before writing: Mirage preserves a shared INPUT/OUTPUT;
        # GNU truncates it when opening the output.
        async with ByteSpool() as stored:
            await stored.fill(output)
            await write_bytes(paths[1], stored.stream())
        return b"", IOResult()
    return output, IOResult()


__all__ = ["engine_config", "uniq_flags", "uniq_generic"]
