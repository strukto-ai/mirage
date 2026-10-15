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

import asyncio
import logging
import os
from pathlib import Path

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.errors import disk_error
from mirage.core.disk.listing_version import folder_version, wall_ns
from mirage.core.disk.stat import stat_of
from mirage.core.disk.utils import read_entries, resolve_inside
from mirage.errors.fs import enoent, enotdir
from mirage.types import DirListing, FileStat, PathSpec
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


def _row_of(
    entry: os.DirEntry[str], now_ns: int, versioned: bool
) -> FileStat | None:
    """An entry as ``stat`` answers it, None for one removed during the
    scan.

    Args:
        entry (os.DirEntry[str]): the host entry.
        now_ns (int): the wall clock, read before the scan.
        versioned (bool): whether the mount stores folder versions.
    """
    try:
        st = entry.stat(follow_symlinks=False)
    except FileNotFoundError as exc:
        logger.debug("%s left during the scan: %s", entry.path, exc)
        return None
    return stat_of(entry.name, st, now_ns, versioned)


def _scan(p: Path, versioned: bool) -> DirListing:
    """The folder's entries, each as ``stat`` answers it, at its version.

    The version is read first: a change landing during the scan then
    leaves the stored version behind the folder's, and the next check
    re-lists instead of serving rows that missed it. A host symlink is
    not an entry of the mount (see ``resolve_inside``), and an entry
    removed during the scan is not listed.

    Args:
        p (Path): the host directory.
        versioned (bool): whether the mount stores folder versions.
    """
    now_ns = wall_ns()
    version = folder_version(p, now_ns) if versioned else None
    rows = [
        row
        for entry in read_entries(p)
        if (row := _row_of(entry, now_ns, versioned)) is not None
    ]
    rows.sort(key=lambda row: row.name)
    return DirListing(rows, version=version)


async def readdir(accessor: DiskAccessor, path_spec: PathSpec) -> DirListing:
    prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
    path = path_spec.directory if path_spec.pattern else path_spec.virtual
    if prefix and path.startswith(prefix):
        rest = path[len(prefix) :]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    p = await resolve_inside(accessor.root, path_spec, path)
    # The kernel already separates ENOENT (a component does not exist) from
    # ENOTDIR (a component exists but is not a directory); let listdir make
    # that call instead of collapsing both into one errno. Restamped onto the
    # PathSpec so the virtual path, never the real fs path, is reported.
    try:
        return await asyncio.to_thread(_scan, p, accessor.folder_versions)
    except FileNotFoundError as exc:
        raise enoent(path_spec) from exc
    except NotADirectoryError as exc:
        raise enotdir(path_spec) from exc
    except OSError as exc:
        raise disk_error(exc, path_spec.virtual) from exc
