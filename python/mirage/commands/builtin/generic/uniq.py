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
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import extra_operand_error, word_refusal_error
from mirage.commands.spec.word_choice import WordMatch, match_word
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.stream import run_stream
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec, StatFn

# The --all-repeated and --group words, in the order GNU lists each
# back. No aliases in either, so one candidate per line.
ALL_REPEATED_ARGS = ("none", "prepend", "separate")
# How GNU reads a -f, -s or -w count: leading C whitespace, a sign and
# decimal digits, nothing after them.
COUNT_WORD = re.compile(r"[ \t\n\v\f\r]*[+-]?[0-9]+")
SKIP_FIELDS = "fields to skip"
SKIP_CHARS = "bytes to skip"
CHECK_CHARS = "bytes to compare"
GROUP_ARGS = ("prepend", "append", "separate", "both")
COUNT_LIMIT = 2**64 - 1


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
    """A -f, -s or -w count: decimal, never negative, any size.

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
    output: ByteSource = run_stream(
        "uniq",
        {
            "count": parsed.count,
            "duplicates_only": parsed.duplicates_only,
            "unique_only": parsed.unique_only,
            "skip_fields": min(parsed.skip_fields, COUNT_LIMIT),
            "skip_chars": min(parsed.skip_chars, COUNT_LIMIT),
            "check_chars": min(parsed.check_chars, COUNT_LIMIT)
            if parsed.check_chars is not None
            else None,
            "ignore_case": parsed.ignore_case,
            "all_repeated": parsed.all_repeated,
            "group": parsed.group,
            "zero_terminated": parsed.zero_terminated,
        },
        source,
    )
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
