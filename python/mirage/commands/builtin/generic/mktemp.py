import random
import string
from collections.abc import Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import rekey

_ALPHABET = string.ascii_letters + string.digits


def _rand_suffix(length: int) -> str:
    return "".join(random.choices(_ALPHABET, k=length))


def _build_path(p: str | PathSpec | None, t: bool,
                texts: tuple[str, ...]) -> tuple[PathSpec, PathSpec]:
    if t or p is None:
        parent = PathSpec.from_str_path("/tmp")
    elif isinstance(p, PathSpec):
        parent = p
    else:
        parent = PathSpec.from_str_path(p)
    template = texts[0] if texts else "tmp.XXXXXXXXXX"
    i = len(template)
    while i > 0 and template[i - 1] == "X":
        i -= 1
    if i < len(template):
        name = template[:i] + _rand_suffix(len(template) - i)
    else:
        name = f"{template}.{_rand_suffix(8)}"
    virtual = f"{parent.virtual.rstrip('/')}/{name}"
    return PathSpec.from_str_path(
        virtual,
        rekey(parent.virtual, parent.resource_path, virtual),
    ), parent


async def mktemp(
    *texts: str,
    mkdir_fn: Callable[..., Awaitable[None]],
    write_bytes_fn: Callable[..., Awaitable[None]],
    accessor: Accessor | None = None,
    d: bool = False,
    p: str | PathSpec | None = None,
    t: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if len(texts) > 1:
        raise extra_operand_error(CommandName.MKTEMP, texts[1])
    path, parent = _build_path(p, t, texts)
    await mkdir_fn(accessor, parent, parents=True)
    if d:
        await mkdir_fn(accessor, path)
    else:
        await write_bytes_fn(accessor, path, b"")
    return (path.virtual + "\n").encode(), IOResult()


__all__ = ["mktemp"]
