import re
from collections.abc import Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.output import format_records
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec

_FORMAT_RE = re.compile(r"%([nsFy]|.)")

_TYPE_LABELS = {
    FileType.DIRECTORY: "directory",
    FileType.TEXT: "regular file",
    FileType.BINARY: "regular file",
    FileType.JSON: "regular file",
    FileType.CSV: "regular file",
}


def _replace_spec(spec: str, s: FileStat, name: str) -> str:
    if spec == "n":
        return name
    if spec == "s":
        return str(s.size if s.size is not None else 0)
    if spec == "F":
        return _TYPE_LABELS.get(s.type,
                                "regular file") if s.type else "regular file"
    if spec == "y":
        return s.modified or ""
    return "?"


def _format_stat(fmt: str, s: FileStat, name: str) -> str:
    return _FORMAT_RE.sub(lambda m: _replace_spec(m.group(1), s, name), fmt)


async def stat(
    paths: list[PathSpec],
    *,
    stat_fn: Callable[..., Awaitable[FileStat]],
    accessor: Accessor | None = None,
    c: str | None = None,
    f: str | None = None,
    index: IndexCacheStore | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("stat: missing operand")
    fmt = c if c is not None else f
    lines: list[str] = []
    for p in paths:
        s = await stat_fn(accessor, p, index)
        if fmt is not None:
            lines.append(_format_stat(fmt, s, p.raw_path))
        else:
            lines.append(f"name={s.name} size={s.size}"
                         f" modified={s.modified}"
                         f" type={s.type.value if s.type else None}")
    return format_records(lines), IOResult()


__all__ = ["stat"]
