import posixpath
from collections.abc import Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.wrap import to_pathspec
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


async def _exists(stat_fn: Callable[..., Awaitable[object]],
                  accessor: Accessor | None, path: PathSpec) -> bool:
    try:
        await stat_fn(accessor, path)
        return True
    except (FileNotFoundError, ValueError):
        return False


async def realpath(
    paths: list[PathSpec],
    *,
    stat_fn: Callable[..., Awaitable[object]],
    accessor: Accessor | None = None,
    e: bool = False,
    m: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    lines: list[str] = []
    for p in paths:
        resolved_display = posixpath.normpath(p.virtual)
        if e:
            prefix = mount_prefix_of(p.virtual, p.resource_path)
            resolved = to_pathspec(resolved_display, prefix)
            if not await _exists(stat_fn, accessor, resolved):
                raise FileNotFoundError(
                    f"realpath: '{p.virtual}': No such file or directory")
        lines.append(resolved_display)
    return ("\n".join(lines) + "\n").encode(), IOResult()


__all__ = ["realpath"]
