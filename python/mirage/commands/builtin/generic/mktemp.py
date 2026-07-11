import random
import string
from collections.abc import Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

_ALPHABET = string.ascii_letters + string.digits


def _rand_suffix(length: int) -> str:
    return "".join(random.choices(_ALPHABET, k=length))


def _build_path(p: str | PathSpec | None, t: bool,
                texts: tuple[str, ...]) -> tuple[str, str]:
    p_str = p.virtual if isinstance(p, PathSpec) else p
    parent = "/tmp" if t else (p_str if p_str else "/tmp")
    template = texts[0] if texts else "tmp.XXXXXXXXXX"
    i = len(template)
    while i > 0 and template[i - 1] == "X":
        i -= 1
    if i < len(template):
        name = template[:i] + _rand_suffix(len(template) - i)
    else:
        name = f"{template}.{_rand_suffix(8)}"
    return f"{parent.rstrip('/')}/{name}", parent


async def mktemp(
    *texts: str,
    mkdir_fn: Callable[..., Awaitable[None]],
    write_bytes_fn: Callable[..., Awaitable[None]],
    accessor: Accessor | None = None,
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
