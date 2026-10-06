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

import errno

from mirage.commands.builtin.utils.paths import descendant_path
from mirage.errors.posix import posix_phrase
from mirage.errors.types import DotWalkLoop, FsCondition
from mirage.types import FileType, PathSpec, StatFn

# The destination verdicts GNU meets at the destination's own stat, before
# any create or rename: a plain file in its chain, or a link loop in it.
# cp and mv both word them ``cannot stat 'DST'`` (coreutils 9.7).
STAT_REFUSALS = (
    posix_phrase(FsCondition.ENOTDIR),
    posix_phrase(FsCondition.ELOOP),
)

_SWALLOW = (FileNotFoundError, ValueError)


def child_path(parent: PathSpec, name: str) -> PathSpec:
    return descendant_path(parent, parent.virtual.rstrip("/") + "/" + name)


def backend_key_default(path: PathSpec) -> str:
    return path.mount_path.rstrip("/")


def copy_targets(
    sources: list[PathSpec],
    dst: PathSpec,
    dst_is_dir: bool,
    dst_exists: bool = True,
    dst_err: str | None = None,
) -> list[tuple[PathSpec, PathSpec]]:
    """Map copy or move sources to their destination paths.

    Follows POSIX operand semantics: when the destination is an existing
    directory each source maps to ``destination/basename``; otherwise a
    single source maps directly to the destination. Multiple sources require
    the directory form, and GNU distinguishes why it is unusable: an absent
    target is ``No such file or directory``; an existing non-directory is
    ``Not a directory``, and so is a target that can never exist because a
    plain file stands in its chain or behind its slash (``cp a b reg/x``,
    ``cp a b reg/``), which the destination probe reports as its strerror
    (identical wording in cp and mv).

    Args:
        sources (list[PathSpec]): Source operands.
        dst (PathSpec): Final operand, the destination.
        dst_is_dir (bool): Whether the destination is an existing directory.
        dst_exists (bool): Whether the destination exists at all; False
            picks GNU's ENOENT wording over ENOTDIR.
        dst_err (str | None): The destination probe's strerror when it can
            be neither found nor created there.

    Returns:
        list[tuple[PathSpec, PathSpec]]: Source-to-target pairs.
    """
    if len(sources) > 1 and not dst_is_dir:
        if dst_err == posix_phrase(FsCondition.ELOOP):
            raise DotWalkLoop(
                errno.ELOOP,
                posix_phrase(FsCondition.ELOOP),
                f"target '{dst.raw_path}'",
            )
        if not dst_exists and dst_err != posix_phrase(FsCondition.ENOTDIR):
            raise FileNotFoundError(f"target '{dst.raw_path}'")
        raise NotADirectoryError(f"target '{dst.raw_path}'")
    if not dst_is_dir:
        return [(sources[0], dst)]
    pairs: list[tuple[PathSpec, PathSpec]] = []
    for src in sources:
        pairs.append((src, child_path(dst, landing_name(src))))
    return pairs


def landing_name(src: PathSpec) -> str:
    """The name a source lands under inside a directory destination.

    GNU names it after the operand as typed, so a link the router
    followed still lands under its own name (``cp al dir`` makes
    ``dir/al``, not ``dir/a.txt``). ``''``, ``.`` and ``..`` name no entry
    of their own, so they keep the name of what they resolve to.

    Args:
        src (PathSpec): the source operand.
    """
    typed = src.raw_path.rstrip("/").rsplit("/", 1)[-1]
    if typed not in ("", ".", ".."):
        return typed
    return src.mount_path.rstrip("/").rsplit("/", 1)[-1]


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
