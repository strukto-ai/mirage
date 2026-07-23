import random
import string
from collections.abc import Awaitable, Callable

from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import rekey

_ALPHABET = string.ascii_letters + string.digits


def _rand_suffix(length: int) -> str:
    return "".join(random.choices(_ALPHABET, k=length))


def _build_path(p: str | PathSpec | None, t: bool, texts: tuple[str, ...],
                suffix: str) -> tuple[PathSpec, PathSpec]:
    template = texts[0] if texts else "tmp.XXXXXXXXXX"
    if t:
        parent = PathSpec.from_str_path("/tmp")
    elif p is not None:
        parent = p if isinstance(p, PathSpec) else PathSpec.from_str_path(p)
    elif "/" in template:
        # An explicit path template names its own directory (GNU); only a
        # bare template with no -p/-t falls back to the temp dir.
        head, _, template = template.rpartition("/")
        parent = PathSpec.from_str_path(head or "/")
    else:
        parent = PathSpec.from_str_path("/tmp")
    i = len(template)
    while i > 0 and template[i - 1] == "X":
        i -= 1
    if i < len(template):
        name = template[:i] + _rand_suffix(len(template) - i) + suffix
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
    d: bool = False,
    p: str | PathSpec | None = None,
    t: bool = False,
    dry_run: bool = False,
    suffix: str = "",
    quiet: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if len(texts) > 1:
        raise extra_operand_error(CommandName.MKTEMP, texts[1])
    path, parent = _build_path(p, t, texts, suffix)
    if not dry_run:
        # -q suppresses diagnostics about file/directory creation only
        # (GNU); usage errors and internal failures still propagate.
        try:
            await mkdir_fn(parent, parents=True)
            if d:
                await mkdir_fn(path)
            else:
                await write_bytes_fn(path, b"")
        except OSError:
            if not quiet:
                raise
            return None, IOResult(exit_code=1)
    return (path.virtual + "\n").encode(), IOResult()


__all__ = ["mktemp"]
