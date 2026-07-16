from collections.abc import Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _build_join_map(
    lines: list[str],
    field_idx: int,
    delimiter: str | None,
) -> dict[str, list[list[str]]]:
    result: dict[str, list[list[str]]] = {}
    for line in lines:
        parts = line.split(delimiter) if delimiter else line.split()
        if field_idx < len(parts):
            key = parts[field_idx]
            rest = parts[:field_idx] + parts[field_idx + 1:]
            if key not in result:
                result[key] = []
            result[key].append(rest)
    return result


def _format_row(
    key: str,
    rest1: list[str],
    rest2: list[str],
    o_fmt: str | None,
    out_sep: str,
) -> str:
    if o_fmt is None:
        return out_sep.join([key] + rest1 + rest2)
    fields: list[str] = []
    for spec in o_fmt.split(","):
        spec = spec.strip()
        if spec == "0":
            fields.append(key)
        else:
            parts = spec.split(".", 1)
            file_n = int(parts[0])
            field_m = int(parts[1]) - 1
            src = rest1 if file_n == 1 else rest2
            if field_m < len(src):
                fields.append(src[field_m])
            else:
                fields.append("")
    return out_sep.join(fields)


def _join_lines(
    lines1: list[str],
    lines2: list[str],
    field1: int,
    field2: int,
    sep: str | None,
    also_unpairable: str | None,
    only_unpairable: str | None,
    empty_value: str | None,
    output_format: str | None,
) -> list[str]:
    map1 = _build_join_map(lines1, field1, sep)
    map2 = _build_join_map(lines2, field2, sep)
    out_sep = sep if sep else " "
    out_lines: list[str] = []
    matched_keys2: set[str] = set()

    for line in lines1:
        parts = line.split(sep) if sep else line.split()
        if field1 >= len(parts):
            continue
        key = parts[field1]
        rest1 = parts[:field1] + parts[field1 + 1:]
        if key in map2:
            matched_keys2.add(key)
            if only_unpairable is None:
                for rest2 in map2[key]:
                    out_lines.append(
                        _format_row(key, rest1, rest2, output_format, out_sep))
        else:
            if only_unpairable == "1" or also_unpairable == "1":
                if (output_format is not None and empty_value is not None
                        and map2):
                    sample = map2[next(iter(map2))][0]
                    placeholder = [empty_value] * len(sample)
                else:
                    placeholder = []
                out_lines.append(
                    _format_row(key, rest1, placeholder, output_format,
                                out_sep))

    if also_unpairable == "2" or only_unpairable == "2":
        for line in lines2:
            parts = line.split(sep) if sep else line.split()
            if field2 >= len(parts):
                continue
            key = parts[field2]
            if key not in matched_keys2:
                rest2 = parts[:field2] + parts[field2 + 1:]
                if (output_format is not None and empty_value is not None
                        and map1):
                    sample = map1[next(iter(map1))][0]
                    placeholder = [empty_value] * len(sample)
                else:
                    placeholder = []
                out_lines.append(
                    _format_row(key, placeholder, rest2, output_format,
                                out_sep))

    return out_lines


async def join_cmd(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: Accessor | None = None,
    field1: int = 0,
    field2: int = 0,
    separator: str | None = None,
    also_unpairable: str | None = None,
    only_unpairable: str | None = None,
    empty_value: str | None = None,
    output_format: str | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(CommandName.JOIN, paths[2].raw_path
                                  or paths[2].virtual)
    if len(paths) < 2:
        raise ValueError("join: requires two paths")
    data1 = (await read_bytes(accessor, paths[0])).decode(errors="replace")
    data2 = (await read_bytes(accessor, paths[1])).decode(errors="replace")
    lines1 = split_lines(data1)
    lines2 = split_lines(data2)
    out_lines = _join_lines(lines1, lines2, field1, field2, separator,
                            also_unpairable, only_unpairable, empty_value,
                            output_format)
    if not out_lines:
        return None, IOResult()
    return ("\n".join(out_lines) + "\n").encode(), IOResult()


__all__ = ["join_cmd"]
