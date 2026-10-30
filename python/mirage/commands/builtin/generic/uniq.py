from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
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
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import extra_operand_error, word_refusal_error
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
    counts: tuple[tuple[str, str], ...] = ()
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


def parse_flags(flags: Mapping[str, FlagValue]) -> UniqFlags:
    fl = FlagView(flags, spec=SPECS["uniq"])
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
    count = fl.as_bool("count")
    repeated = fl.as_bool("repeated")
    unique = fl.as_bool("unique")
    if group is not None and (
        count or repeated or unique or all_repeated is not None
    ):
        raise ValueError(
            "uniq: --group is mutually exclusive with -c/-d/-D/-u"
        )
    if count and all_repeated is not None:
        raise ValueError(
            "uniq: printing all duplicated lines and repeat "
            "counts is meaningless"
        )
    return UniqFlags(
        count=count,
        repeated=repeated,
        unique=unique,
        counts=tuple(fl.texts("skip_fields", "skip_chars", "check_chars")),
        ignore_case=fl.as_bool("ignore_case"),
        all_repeated=all_repeated,
        group=group,
        zero_terminated=fl.as_bool("zero_terminated"),
    )


def uniq_flags(flags: Mapping[str, FlagValue]) -> UniqFlags | IOResult:
    """uniq's options, its counts refused by the engine before any operand
    is resolved.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags.

    Returns:
        UniqFlags | IOResult: the flags, or uniq's refusal.
    """
    try:
        parsed = parse_flags(flags)
    except UsageError as exc:
        return IOResult(
            exit_code=exc.exit_code, stderr=encode_text(str(exc) + "\n")
        )
    except ValueError as exc:
        return IOResult(exit_code=1, stderr=encode_text(str(exc) + "\n"))
    try:
        open_stream("uniq", engine_config(parsed))
    except StreamRefusal as refusal:
        return refused(refusal)
    return parsed


def engine_config(parsed: UniqFlags) -> dict[str, JsonValue]:
    """The uniq engine's config, the counts as typed.

    Args:
        parsed (UniqFlags): the options.
    """
    config: dict[str, JsonValue] = {
        "count": parsed.count,
        "repeated": parsed.repeated,
        "unique": parsed.unique,
        "counts": [[name, byte_view(text)] for name, text in parsed.counts],
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
    if len(paths) > 2:
        raise extra_operand_error(
            CommandName.UNIQ, paths[2].raw_path or paths[2].virtual
        )
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
