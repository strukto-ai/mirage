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

from mirage.accessor.tidb_filesystem import TiDBFilesystemAccessor
from mirage.core.tidb_filesystem.client import stat_entries
from mirage.core.tidb_filesystem.path import backend_path
from mirage.core.tidb_filesystem.types import Entry, Kinds
from mirage.errors.fs import eexist, einval, eisdir, enoent, enotdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path
from mirage.utils.path import ancestors


async def kinds_of(accessor: TiDBFilesystemAccessor, keys: list[str]) -> Kinds:
    """What each mount-local path is, in one fs:batch-stat.

    drive9 creates missing parents on a write, a mkdir and a file rename,
    and keeps a file and a directory of one name side by side, so the
    errno ``open(2)`` or ``rename(2)`` would answer has to be worked out
    here from what the paths are before the call. Each path is asked
    bare, which answers the file of a name that is both, and with a
    trailing slash, kept under ``key + "/"``, which answers only a
    directory.

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        keys (list[str]): normalized mount-local paths; the mount root is
            always a directory and is not asked.
    """
    asked = [key for key in dict.fromkeys(keys) if key != "/"]
    remote = [backend_path(accessor.config, key) for key in asked]
    found = await stat_entries(
        accessor, [*remote, *(path + "/" for path in remote)]
    )
    kinds: Kinds = dict(zip(asked, found))
    kinds.update(zip((key + "/" for key in asked), found[len(asked) :]))
    kinds["/"] = Entry("/", True, 0, None)
    return kinds


def folder_of(kinds: Kinds, key: str) -> Entry | None:
    """What ``key`` is as a folder on a longer path: the directory of a
    name that is also a file, as a listing shows it, else what is there.

    Args:
        kinds (Kinds): what the paths are, from :func:`kinds_of`.
        key (str): the normalized mount-local path.
    """
    return kinds.get(key.rstrip("/") + "/") or kinds.get(key)


def broken_parent(kinds: Kinds, spec: PathSpec, key: str) -> OSError | None:
    """ENOTDIR for a file above ``key``, ENOENT for a missing directory
    above it, the first the walk meets, as the kernel resolves a path.

    Args:
        kinds (Kinds): what the paths are, ``key``'s ancestors included.
        spec (PathSpec): the operand, reported in the error.
        key (str): the normalized mount-local path.
    """
    for ancestor in ancestors(key):
        entry = folder_of(kinds, ancestor)
        if entry is None:
            return enoent(spec)
        if not entry.is_dir:
            return enotdir(spec)
    return None


def lookup_error(kinds: Kinds, spec: PathSpec, key: str) -> OSError:
    broken = broken_parent(kinds, spec, key)
    return broken if broken is not None else enoent(spec)


def check_write_target(kinds: Kinds, spec: PathSpec, key: str) -> None:
    broken = broken_parent(kinds, spec, key)
    if broken is not None:
        raise broken
    entry = kinds.get(key)
    if entry is not None and entry.is_dir:
        raise eisdir(spec)


def check_mkdir_target(
    kinds: Kinds, spec: PathSpec, key: str, parents: bool
) -> bool:
    """Refuse a mkdir GNU refuses; True when ``-p`` finds it done.

    Plain ``mkdir`` is EEXIST for anything at the target and owes the
    parent chain the walk a write owes it. ``-p`` names the component it
    trips on: a file above the target is ENOTDIR, the target as a file
    EEXIST, and the target as a directory is success.

    Args:
        kinds (Kinds): what the target and its ancestors are.
        spec (PathSpec): the operand, reported in the error.
        key (str): the normalized mount-local path.
        parents (bool): whether ``-p`` was given.
    """
    entry = kinds.get(key)
    if not parents:
        if entry is not None:
            raise eexist(spec)
        broken = broken_parent(kinds, spec, key)
        if broken is not None:
            raise broken
        return False
    for component in ancestors(key):
        above = folder_of(kinds, component)
        if above is not None and not above.is_dir:
            raise enotdir(mounted_path(spec, component))
    if entry is not None and not entry.is_dir:
        raise eexist(spec)
    return entry is not None


def check_rename(
    kinds: Kinds,
    src_spec: PathSpec,
    s: str,
    dst_spec: PathSpec,
    d: str,
) -> None:
    """Refuse a rename ``rename(2)`` refuses once both ends resolve.

    A missing destination parent is ENOENT and a file above it ENOTDIR; a
    file onto a directory is EISDIR, a directory onto a file ENOTDIR, and
    into its own subtree EINVAL. A directory onto one that holds entries
    is left to drive9, which answers it with a conflict.

    Args:
        kinds (Kinds): what both ends and their ancestors are.
        src_spec (PathSpec): the source operand, reported in the error.
        s (str): the normalized source path.
        dst_spec (PathSpec): the destination operand, reported in the
            error.
        d (str): the normalized destination path.
    """
    broken = broken_parent(kinds, dst_spec, d)
    if broken is not None:
        raise broken
    source = kinds.get(s)
    if source is None:
        raise lookup_error(kinds, src_spec, s)
    if s == d:
        return
    target = kinds.get(d)
    if not source.is_dir:
        if target is not None and target.is_dir:
            raise eisdir(dst_spec)
        return
    if d.startswith(s.rstrip("/") + "/"):
        raise einval(src_spec)
    if target is not None and not target.is_dir:
        raise enotdir(dst_spec)
