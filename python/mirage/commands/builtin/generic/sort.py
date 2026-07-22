from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.sort_helper import (SortKeyError, build_config,
                                                 compare_lines, sort_lines)
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


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


def _bool_alias(fl: FlagView, short: str, long: str) -> bool:
    return fl.as_bool(short) or fl.as_bool(long)


def parse_flags(flags: Mapping[str, object]) -> SortFlags:
    fl = FlagView(flags, spec=SPECS["sort"])
    raw_check = fl.raw("check")
    if raw_check not in (None, True, "diagnose-first", "quiet", "silent"):
        raise ValueError(f"invalid argument '{raw_check}' for '--check'")
    raw_output = fl.raw("o") or fl.raw("output")
    output = raw_output if isinstance(raw_output, PathSpec) else None
    key_defs = tuple(fl.as_list("k") + fl.as_list("key"))
    return SortFlags(
        reverse=_bool_alias(fl, "r", "reverse"),
        numeric=_bool_alias(fl, "n", "numeric_sort"),
        unique=_bool_alias(fl, "u", "unique"),
        fold_case=_bool_alias(fl, "f", "ignore_case"),
        key_defs=key_defs,
        field_separator=(fl.as_str("t") or fl.as_str("field_separator")),
        human_numeric=_bool_alias(fl, "h", "human_numeric_sort"),
        version_sort=_bool_alias(fl, "V", "version_sort"),
        month_sort=_bool_alias(fl, "M", "month_sort"),
        ignore_blanks=_bool_alias(fl, "b", "ignore_leading_blanks"),
        stable=_bool_alias(fl, "s", "stable"),
        check=fl.as_bool("c") or raw_check is not None,
        check_quiet=raw_check in ("quiet", "silent"),
        dictionary=_bool_alias(fl, "d", "dictionary_order"),
        general_numeric=_bool_alias(fl, "g", "general_numeric_sort"),
        ignore_nonprinting=_bool_alias(fl, "i", "ignore_nonprinting"),
        merge=_bool_alias(fl, "m", "merge"),
        output=output,
        zero_terminated=_bool_alias(fl, "z", "zero_terminated"),
    )


def _split_records(raw: bytes, zero_terminated: bool) -> list[str]:
    if not zero_terminated:
        return split_lines(raw.decode(errors="replace"))
    records = raw.split(b"\x00")
    if records and records[-1] == b"":
        records.pop()
    return [record.decode(errors="replace") for record in records]


async def sort(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]] | None = None,
    stdin: ByteSource | None = None,
    flags: Mapping[str, object] | None = None,
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
    try:
        parsed = parse_flags(flags) if flags is not None else SortFlags(
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
        cfg = build_config(
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
    except (SortKeyError, ValueError) as exc:
        return b"", IOResult(stderr=f"sort: {exc}\n".encode(), exit_code=2)

    if parsed.check and len(paths) > 1:
        label = paths[1].raw_path or paths[1].virtual
        return b"", IOResult(
            stderr=f"sort: extra operand '{label}' not allowed with -c\n".
            encode(),
            exit_code=2,
        )
    raw = b""
    if paths:
        for path in paths:
            raw += await read_bytes(path)
    else:
        raw = await _read_stdin_async(stdin) or b""
    records = _split_records(raw, parsed.zero_terminated)

    if parsed.check:
        for index in range(1, len(records)):
            comparison = compare_lines(records[index - 1], records[index], cfg)
            if comparison > 0 or (parsed.unique and comparison == 0):
                if parsed.check_quiet:
                    return b"", IOResult(exit_code=1)
                label = ((paths[0].raw_path or paths[0].virtual)
                         if paths else "-")
                error = (f"sort: {label}:{index + 1}: disorder: "
                         f"{records[index]}\n")
                return b"", IOResult(stderr=error.encode(), exit_code=1)
        return b"", IOResult()

    ordered = sort_lines(records, cfg)
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
        await write_bytes(parsed.output, output)
        return b"", IOResult(writes={parsed.output.mount_path: output},
                             cache=[parsed.output.mount_path])
    return output, IOResult()


__all__ = ["sort"]
