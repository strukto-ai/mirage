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


import posixpath
from dataclasses import replace

from mirage.commands.builtin.utils.paths import descendant_path
from mirage.errors.fs import eloop, enoent, enotdir
from mirage.errors.types import FsCondition
from mirage.types import FileType, PathSpec, StatFn
from mirage.utils.path import parent

# The destination verdicts met at the destination's own stat, before any
# create or rename: a plain file in its chain, or a link loop in it. cp
# and mv both word them ``cannot stat 'DST'``.
STAT_REFUSALS = frozenset({FsCondition.ENOTDIR, FsCondition.ELOOP})

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
    dst_err: FsCondition | None = None,
    dotdot: str = "..",
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
        dst_err (FsCondition | None): The destination probe's condition
            when it can be neither found nor created there.
        dotdot (str): What a source typed as ``..`` lands as: ``..``,
            the destination's parent, for mv; ``.`` for cp, which never
            copies into ``dir/..`` (coreutils 9.7).

    Returns:
        list[tuple[PathSpec, PathSpec]]: Source-to-target pairs.
    """
    if len(sources) > 1 and not dst_is_dir:
        label = f"target '{dst.raw_path}'"
        if dst_err is FsCondition.ELOOP:
            raise eloop(label)
        if not dst_exists and dst_err is not FsCondition.ENOTDIR:
            raise enoent(label)
        raise enotdir(label)
    if not dst_is_dir:
        return [(sources[0], dst)]
    return [(src, landing_path(dst, src, dotdot)) for src in sources]


def typed_name(src: PathSpec) -> str:
    """The operand's last component as typed, trailing slashes dropped.

    Args:
        src (PathSpec): the operand.
    """
    return src.raw_path.rstrip("/").rsplit("/", 1)[-1]


def landing_path(dst: PathSpec, src: PathSpec, dotdot: str = "..") -> PathSpec:
    """Where a source lands inside a directory destination.

    GNU appends the operand's last component as typed, so a link the
    router followed still lands under its own name (``cp al dir`` makes
    ``dir/al``, not ``dir/a.txt``), and ``s/.`` lands at ``dir/.``, the
    directory itself: ``cp -r s/. dir`` merges s's contents into dir.
    An operand with no name of its own (the root) keeps the name of
    what it resolves to.

    Args:
        dst (PathSpec): the directory destination.
        src (PathSpec): the source operand.
        dotdot (str): what a ``..`` operand lands as (see copy_targets).
    """
    typed = typed_name(src)
    if typed == "..":
        typed = dotdot
    if typed == "":
        typed = src.mount_path.rstrip("/").rsplit("/", 1)[-1]
    if typed not in (".", ".."):
        return child_path(dst, typed)
    shown = posixpath.join(dst.raw_path, typed)
    if typed == ".":
        return replace(dst, raw_path=shown)
    above = descendant_path(dst, parent(dst.virtual.rstrip("/")))
    return replace(above, raw_path=shown)


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
