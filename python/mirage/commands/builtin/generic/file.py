import logging
from collections.abc import Awaitable, Callable

from mirage.commands.builtin.file_helper import _detect
from mirage.commands.builtin.utils.output import format_records
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec

_logger = logging.getLogger(__name__)

_MIME_MAP: dict[str, str] = {
    "text": "text/plain; charset=us-ascii",
    "json": "application/json; charset=us-ascii",
    "csv": "text/csv; charset=us-ascii",
    "directory": "inode/directory",
    "binary": "application/octet-stream",
    "image/png": "image/png",
    "image/jpeg": "image/jpeg",
    "image/gif": "image/gif",
    "application/zip": "application/zip",
    "application/gzip": "application/gzip",
    "application/pdf": "application/pdf",
    "parquet": "application/octet-stream",
    "orc": "application/octet-stream",
    "feather": "application/octet-stream",
    "hdf5": "application/octet-stream",
}


def _format_file_result(
    path: str,
    result: FileType | str,
    brief: bool,
    mime: bool,
) -> str:
    key = result.value if isinstance(result, FileType) else str(result)
    desc = _MIME_MAP.get(key, key) if mime else key
    if brief:
        return desc
    return f"{path}: {desc}"


async def file_cmd(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stat_fn: Callable[..., Awaitable[FileStat]],
    b: bool = False,
    i: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("file: missing operand")
    lines: list[str] = []
    for p in paths:
        s = await stat_fn(p)
        if s.type == FileType.DIRECTORY:
            lines.append(
                _format_file_result(p.virtual, FileType.DIRECTORY, b, i))
            continue
        try:
            header = (await read_bytes(p))[:512]
        except Exception as exc:
            _logger.debug("file: failed to read header for %s: %s", p.virtual,
                          exc)
            header = b""
        result = _detect(p.virtual, header, s)
        lines.append(_format_file_result(p.virtual, result, b, i))
    return format_records(lines), IOResult()


__all__ = ["file_cmd"]
