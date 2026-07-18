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

from mirage.types import FileType, PathSpec, StatFn
from mirage.utils.key_prefix import rekey

_SWALLOW = (FileNotFoundError, ValueError)


def child_path(parent: PathSpec, name: str) -> PathSpec:
    child = parent.virtual.rstrip("/") + "/" + name
    return PathSpec.from_str_path(
        child, rekey(parent.virtual, parent.resource_path, child))


def backend_key_default(path: PathSpec) -> str:
    return path.mount_path.rstrip("/")


def copy_targets(sources: list[PathSpec], dst: PathSpec,
                 dst_is_dir: bool) -> list[tuple[PathSpec, PathSpec]]:
    """Map copy or move sources to their destination paths.

    Follows POSIX operand semantics: when the destination is an existing
    directory each source maps to ``destination/basename``; otherwise a
    single source maps directly to the destination. Multiple sources require
    the directory form.

    Args:
        sources (list[PathSpec]): Source operands.
        dst (PathSpec): Final operand, the destination.
        dst_is_dir (bool): Whether the destination is an existing directory.

    Returns:
        list[tuple[PathSpec, PathSpec]]: Source-to-target pairs.
    """
    if len(sources) > 1 and not dst_is_dir:
        raise NotADirectoryError(f"target '{dst.virtual}'")
    if not dst_is_dir:
        return [(sources[0], dst)]
    pairs: list[tuple[PathSpec, PathSpec]] = []
    for src in sources:
        name = src.mount_path.rstrip("/").rsplit("/", 1)[-1]
        pairs.append((src, child_path(dst, name)))
    return pairs


async def path_exists(stat: StatFn, path: PathSpec) -> bool:
    # No index: a no-clobber probe must see targets written earlier in the
    # same command (duplicate basenames), which the cache does not reflect.
    try:
        await stat(path)
    except _SWALLOW:
        return False
    return True


async def is_directory(stat: StatFn, path: PathSpec) -> bool:
    try:
        info = await stat(path)
    except _SWALLOW:
        return False
    return info.type == FileType.DIRECTORY
