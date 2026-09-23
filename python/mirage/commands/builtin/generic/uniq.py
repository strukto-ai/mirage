import re
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.stream import (is_stdin, resolve_source,
                                                  stdin_stream)
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.argmatch import ArgmatchMatch, argmatch
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import argmatch_error, extra_operand_error
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec

# GNU's `delimit_method_string` and `grouping_method_string`, in
# declaration order, which is what each option lists back. No aliases in
# either, so one candidate per line.
ALL_REPEATED_ARGS = ("none", "prepend", "separate")
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


def _parse_count(value: str | None) -> int | None:
    if value is None:
        return None
    normalized = value.strip()
    if re.fullmatch(r"[+-]?[0-9]+", normalized) is None:
        raise ValueError(f"uniq: invalid count: '{value}'")
    count = int(normalized)
    if count < 0:
        raise ValueError(f"uniq: invalid count: '{value}'")
    return count


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
        all_repeated = _method_word("--all-repeated", all_repeated,
                                    ALL_REPEATED_ARGS)
    raw_group = fl.raw("group")
    group = "separate" if raw_group is True else raw_group
    if group is not None:
        group = _method_word("--group", str(group), GROUP_ARGS)
    count = fl.as_bool("count")
    duplicates_only = fl.as_bool("repeated")
    unique_only = fl.as_bool("unique")
    if group is not None and (count or duplicates_only or unique_only
                              or all_repeated is not None):
        raise ValueError(
            "uniq: --group is mutually exclusive with -c/-d/-D/-u")
    if count and all_repeated is not None:
        raise ValueError("uniq: printing all duplicated lines and repeat "
                         "counts is meaningless")
    return UniqFlags(
        count=count,
        duplicates_only=duplicates_only,
        unique_only=unique_only,
        skip_fields=_parse_count(fl.as_str("skip_fields")) or 0,
        skip_chars=_parse_count(fl.as_str("skip_chars")) or 0,
        ignore_case=fl.as_bool("ignore_case"),
        check_chars=_parse_count(fl.as_str("check_chars")),
        all_repeated=all_repeated,
        group=group,
        zero_terminated=fl.as_bool("zero_terminated"),
    )


def _skip_fields(text: str, count: int) -> str:
    index = 0
    for _ in range(count):
        while index < len(text) and text[index] in " \t":
            index += 1
        while index < len(text) and text[index] not in " \t":
            index += 1
    return text[index:]


def _comparison_key(line: bytes, flags: UniqFlags) -> str:
    text = _skip_fields(line.decode(errors="replace"), flags.skip_fields)
    if flags.skip_chars > 0:
        text = text[flags.skip_chars:]
    if flags.check_chars is not None:
        text = text[:flags.check_chars]
    if flags.ignore_case:
        text = text.lower()
    return text


async def _records(source: AsyncIterator[bytes],
                   separator: bytes) -> AsyncIterator[bytes]:
    buffer = b""
    async for chunk in source:
        buffer += chunk
        while separator in buffer:
            record, buffer = buffer.split(separator, 1)
            yield record
    if buffer:
        yield buffer


def _format_record(line: bytes, count: int, flags: UniqFlags,
                   separator: bytes) -> bytes:
    if flags.count:
        return f"{count:>7} ".encode() + line + separator
    return line + separator


def _group_separator_before(index: int, method: str) -> bool:
    if method in ("prepend", "both"):
        return True
    return method in ("separate", "append") and index > 0


async def _uniq_stream(source: AsyncIterator[bytes],
                       flags: UniqFlags) -> AsyncIterator[bytes]:
    separator = b"\x00" if flags.zero_terminated else b"\n"
    groups: list[list[bytes]] = []
    current: list[bytes] = []
    current_key: str | None = None
    async for line in _records(source, separator):
        key = _comparison_key(line, flags)
        if current and key != current_key:
            groups.append(current)
            current = []
        current.append(line)
        current_key = key
    if current:
        groups.append(current)

    if flags.group is not None:
        for index, group in enumerate(groups):
            if _group_separator_before(index, flags.group):
                yield separator
            for line in group:
                yield line + separator
        if groups and flags.group in ("append", "both"):
            yield separator
        return

    if flags.all_repeated is not None:
        emitted = 0
        for group in groups:
            if len(group) == 1:
                continue
            if flags.all_repeated == "prepend" or (
                    flags.all_repeated == "separate" and emitted > 0):
                yield separator
            for line in group:
                yield line + separator
            emitted += 1
        return

    for group in groups:
        count = len(group)
        if flags.duplicates_only and count == 1:
            continue
        if flags.unique_only and count > 1:
            continue
        yield _format_record(group[0], count, flags, separator)


async def uniq(
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
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(CommandName.UNIQ, paths[2].raw_path
                                  or paths[2].virtual)
    try:
        parsed = parse_flags(flags) if flags is not None else UniqFlags(
            count=count,
            duplicates_only=duplicates_only,
            unique_only=unique_only,
            skip_fields=_parse_count(skip_fields) or 0,
            skip_chars=_parse_count(skip_chars) or 0,
            ignore_case=ignore_case,
            check_chars=_parse_count(check_chars),
        )
    except UsageError as exc:
        return None, IOResult(exit_code=exc.exit_code,
                              stderr=(str(exc) + "\n").encode())
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=(str(exc) + "\n").encode())
    read_stream = stdin_stream(read_stream, stdin)
    cache: list[str] = []
    if paths:
        source = read_stream(paths[0])
        cache = [] if is_stdin(paths[0]) else [paths[0].mount_path]
    else:
        source = resolve_source(stdin)
    output: ByteSource = _uniq_stream(source, parsed)
    if len(paths) == 2 and paths[1].raw_path != "-":
        if write_bytes is None:
            return None, IOResult(exit_code=1,
                                  stderr=b"uniq: output is not writable\n")
        data = await materialize(output)
        await write_bytes(paths[1], data)
        return b"", IOResult(writes={paths[1].mount_path: data},
                             cache=cache + [paths[1].mount_path])
    return output, IOResult(cache=cache)


__all__ = ["uniq"]
