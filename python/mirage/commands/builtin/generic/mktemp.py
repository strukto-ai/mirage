import uuid
from collections.abc import Awaitable, Callable

from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _build_path(p: str | PathSpec | None, t: bool,
                texts: tuple[str, ...]) -> tuple[str, str]:
    p_str = p.original if isinstance(p, PathSpec) else p
    parent = "/tmp" if t else (p_str if p_str else "/tmp")
    suffix = str(uuid.uuid4())[:8]
    template = texts[0] if texts else "tmp.XXXXXXXXXX"
    name = template.replace(
        "X" * template.count("X"),
        suffix) if "X" in template else f"{template}.{suffix}"
    return f"{parent.rstrip('/')}/{name}", parent


async def mktemp(
    *texts: str,
    mkdir_fn: Callable[..., Awaitable[None]],
    write_bytes_fn: Callable[..., Awaitable[None]],
    accessor: object = None,
    d: bool = False,
    p: str | PathSpec | None = None,
    t: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    path, parent = _build_path(p, t, texts)
    await mkdir_fn(accessor, parent, parents=True)
    if d:
        await mkdir_fn(accessor, path)
    else:
        await write_bytes_fn(accessor, path, b"")
    return (path + "\n").encode(), IOResult()


__all__ = ["mktemp"]
