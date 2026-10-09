# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from collections.abc import Awaitable, Callable

from mirage.commands.builtin.generic.archive.walk import StatFn
from mirage.errors.constants import FS_ERRORS
from mirage.types import FileType, PathSpec


def extract_dest(
    explicit: PathSpec | str | None, cwd: PathSpec | str, relay: bool
) -> str:
    """Where extraction lands: the explicit operand, else the cwd.

    Relay entry points route by full virtual path, accessor entry points by
    mount-relative path, so the same operand renders differently per
    entry point space. Outside a workspace the cwd arrives as a plain string
    and the two spaces coincide.

    Args:
        explicit (PathSpec | str | None): tar's last -C or unzip's -d,
            when the line named one.
        cwd (PathSpec | str): the session working directory.
        relay (bool): True when the entry points are dispatch-relayed.
    """
    target = explicit if explicit is not None else cwd
    if isinstance(target, PathSpec):
        return target.virtual if relay else target.mount_path
    return target or "/"


async def dir_exists(stat: StatFn, level: str) -> bool:
    """Whether a directory already stands at this path.

    Args:
        stat (StatFn): stat function in the same path space as ``level``.
        level (str): the directory path to probe.
    """
    try:
        found = await stat(PathSpec.from_str_path(level))
    except FS_ERRORS:
        return False
    return found is not None and found.type == FileType.DIRECTORY


async def ensure_dir(
    dir_path: str,
    mkdir_fn: Callable[..., Awaitable[None]],
    stat: StatFn,
    made: set[str],
) -> None:
    """Create one directory chain top-down, skipping what exists.

    The dispatch mkdir op is single-level on most backends (the
    ``mkdir_parents`` knob is a per-backend exception), so extraction
    walks the chain itself the way relay cp does: probe, then create
    only what is missing, memoized per run so an archive of many files
    stats each ancestor once.

    Args:
        dir_path (str): the directory whose chain must exist.
        mkdir_fn (Callable): mkdir function, single level.
        stat (StatFn): stat function in the same path space.
        made (set[str]): levels already ensured this run, updated here.
    """
    parts = [p for p in dir_path.strip("/").split("/") if p]
    for i in range(1, len(parts) + 1):
        level = "/" + "/".join(parts[:i])
        if level in made:
            continue
        if not await dir_exists(stat, level):
            await mkdir_fn(PathSpec.from_str_path(level))
        made.add(level)
