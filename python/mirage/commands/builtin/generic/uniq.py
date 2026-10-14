import re
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import split_readable
from mirage.commands.builtin.utils.stream import (
    resolve_source,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.argmatch import ArgmatchMatch, argmatch
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import argmatch_error, extra_operand_error
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.shell.bytes import decode_text, encode_text
from mirage.types import PathSpec, StatFn

# GNU's `delimit_method_string` and `grouping_method_string`, in
# declaration order, which is what each option lists back. No aliases in
# either, so one candidate per line.
ALL_REPEATED_ARGS = ("none", "prepend", "separate")
# GNU's size_opt reads a count with xstrtoimax: leading C whitespace, a
# sign and decimal digits, nothing after them.
COUNT_WORD = re.compile(r"[ \t\n\v\f\r]*[+-]?[0-9]+")
SKIP_FIELDS = "fields to skip"
SKIP_CHARS = "bytes to skip"
CHECK_CHARS = "bytes to compare"
GROUP_ARGS = ("prepend", "append", "separate", "both")


@dataclass(frozen=True, slots=True)
class UniqFlags:
    count: bool = False
    duplicates_only: bool = False
    unique_only: bool = False
    skip_fields: int = 0
    skip_chars: int = 0
    ignore_case: bool = False
    check_chars: int | None = None
    all_repeated: str | None = None
    group: str | None = None
    zero_terminated: bool = False


def _parse_count(value: str | None, what: str) -> int | None:
    """GNU's ``size_opt``: a decimal count, never negative, any size.

    Args:
        value (str | None): the option's value as typed.
        what (str): what the count counts, for GNU's refusal
            (``fields to skip``).
    """
    if value is None:
        return None
    if COUNT_WORD.fullmatch(value) is None or int(value) < 0:
        raise ValueError(f"uniq: {value}: invalid number of {what}")
    return int(value)


def _method_word(option: str, value: str, allowed: tuple[str, ...]) -> str:
    """One ``--group``/``--all-repeated`` word, ARGMATCH-resolved.

    Args:
        option (str): the option's long spelling, for the refusal.
        value (str): the method word as typed.
        allowed (tuple[str, ...]): GNU's candidates in declaration
            order, one value each (neither option has aliases).
    """
    match = argmatch(value, allowed)
    if not isinstance(match, ArgmatchMatch):
        raise argmatch_error("uniq", option, value, allowed, None, match.kind)
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
    duplicates_only = fl.as_bool("repeated")
    unique_only = fl.as_bool("unique")
    if group is not None and (
        count or duplicates_only or unique_only or all_repeated is not None
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
        duplicates_only=duplicates_only,
        unique_only=unique_only,
        skip_fields=_parse_count(fl.as_str("skip_fields"), SKIP_FIELDS) or 0,
        skip_chars=_parse_count(fl.as_str("skip_chars"), SKIP_CHARS) or 0,
        ignore_case=fl.as_bool("ignore_case"),
        check_chars=_parse_count(fl.as_str("check_chars"), CHECK_CHARS),
        all_repeated=all_repeated,
        group=group,
        zero_terminated=fl.as_bool("zero_terminated"),
    )


def _skip_fields(text: str, count: int) -> str:
    index = 0
    for _ in range(count):
        if index >= len(text):
            break
        while index < len(text) and text[index] in " \t":
            index += 1
        while index < len(text) and text[index] not in " \t":
            index += 1
    return text[index:]


def _comparison_key(line: bytes, flags: UniqFlags) -> str:
    text = _skip_fields(decode_text(line), flags.skip_fields)
    if flags.skip_chars > 0:
        text = text[flags.skip_chars :]
    if flags.check_chars is not None:
        text = text[: flags.check_chars]
    if flags.ignore_case:
        text = text.lower()
    return text


def _format_record(
    line: bytes, count: int, flags: UniqFlags, separator: bytes
) -> bytes:
    if flags.count:
        return encode_text(f"{count:>7} ") + line + separator
    return line + separator


def _group_separator_before(index: int, method: str) -> bool:
    if method in ("prepend", "both"):
        return True
    return method in ("separate", "append") and index > 0


async def _uniq_stream(
    source: AsyncIterator[bytes], flags: UniqFlags
) -> AsyncIterator[bytes]:
    separator = b"\x00" if flags.zero_terminated else b"\n"
    reader = AsyncLineIterator(source)
    first: bytes | None = None
    current_key: str | None = None
    count = 0
    group_index = -1
    repeated_groups = 0
    try:
        while True:
            line = await reader.readline(separator)
            key = None if line is None else _comparison_key(line, flags)
            if line is None or first is None or key != current_key:
                if (
                    first is not None
                    and flags.all_repeated is None
                    and (flags.count or flags.unique_only)
                ):
                    if not (flags.duplicates_only and count == 1) and not (
                        flags.unique_only and count > 1
                    ):
                        yield _format_record(first, count, flags, separator)
                if line is None:
                    break
                first, current_key, count = line, key, 0
                group_index += 1
            count += 1
            if flags.group is not None:
                if count == 1 and _group_separator_before(
                    group_index, flags.group
                ):
                    yield separator
                yield line + separator
            elif flags.all_repeated is not None:
                if count == 2:
                    if flags.all_repeated == "prepend" or (
                        flags.all_repeated == "separate"
                        and repeated_groups > 0
                    ):
                        yield separator
                    yield first + separator
                    repeated_groups += 1
                if count >= 2:
                    yield line + separator
            elif not (flags.count or flags.unique_only):
                if count == (2 if flags.duplicates_only else 1):
                    yield first + separator
        if first is not None and flags.group in ("append", "both"):
            yield separator
    finally:
        await reader.discard()


async def uniq_generic(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]] | None = None,
    stdin: ByteSource | None = None,
    flags: Mapping[str, FlagValue] | None = None,
    count: bool = False,
    duplicates_only: bool = False,
    unique_only: bool = False,
    skip_fields: str | None = None,
    skip_chars: str | None = None,
    ignore_case: bool = False,
    check_chars: str | None = None,
    stat: StatFn | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(
            CommandName.UNIQ, paths[2].raw_path or paths[2].virtual
        )
    try:
        parsed = (
            parse_flags(flags)
            if flags is not None
            else UniqFlags(
                count=count,
                duplicates_only=duplicates_only,
                unique_only=unique_only,
                skip_fields=_parse_count(skip_fields, SKIP_FIELDS) or 0,
                skip_chars=_parse_count(skip_chars, SKIP_CHARS) or 0,
                ignore_case=ignore_case,
                check_chars=_parse_count(check_chars, CHECK_CHARS),
            )
        )
    except UsageError as exc:
        return None, IOResult(
            exit_code=exc.exit_code, stderr=encode_text(str(exc) + "\n")
        )
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=encode_text(str(exc) + "\n"))
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
    output: ByteSource = _uniq_stream(source, parsed)
    if len(paths) == 2 and paths[1].raw_path != "-":
        if write_bytes is None:
            return None, IOResult(
                exit_code=1, stderr=b"uniq: output is not writable\n"
            )
        data = await materialize(output)
        await write_bytes(paths[1], data)
        return b"", IOResult()
    return output, IOResult()


__all__ = ["uniq_generic"]
