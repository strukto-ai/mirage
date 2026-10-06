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
from pathlib import Path

from mirage.accessor.disk import DiskAccessor
from mirage.cache.index import (
    NULL_INDEX,
    IndexCacheStore,
    IndexEntry,
    ResourceType,
)
from mirage.core.disk.errors import disk_error
from mirage.core.disk.listing_version import folder_version, wall_ns
from mirage.core.disk.utils import read_entries, resolve_inside
from mirage.errors.fs import enoent, enotdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


def _entry_types(p: Path) -> dict[str, ResourceType]:
    """The entry names and types in a host directory, less its symlinks.

    A host symlink is not an entry of the mount (see ``resolve_inside``).

    Args:
        p (Path): the host directory.
    """
    return {
        entry.name: ResourceType.FOLDER
        if entry.is_dir(follow_symlinks=False)
        else ResourceType.FILE
        for entry in read_entries(p)
    }


def _scan(
    p: Path, versioned: bool
) -> tuple[str | None, dict[str, ResourceType]]:
    """The folder's version, then its entries.

    The version is read first: a change landing during the scan then
    leaves the stored version behind the folder's, and the next check
    re-lists instead of serving rows that missed it.

    Args:
        p (Path): the host directory.
        versioned (bool): whether the mount stores folder versions.
    """
    version = folder_version(p, wall_ns()) if versioned else None
    return version, _entry_types(p)


async def readdir(
    accessor: DiskAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
    path = path_spec.directory if path_spec.pattern else path_spec.virtual
    if prefix and path.startswith(prefix):
        rest = path[len(prefix) :]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    root = accessor.root
    # Canonical key: no trailing slash (except root), or the same dir
    # indexes under two keys and cache hits return doubled-slash entries.
    virtual_key = prefix + path if prefix else path
    virtual_key = virtual_key.rstrip("/") or "/"
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    p = await resolve_inside(root, path_spec, path)
    base = "/" + path.strip("/")
    # The kernel already separates ENOENT (a component does not exist) from
    # ENOTDIR (a component exists but is not a directory); let listdir make
    # that call instead of collapsing both into one errno. Restamped onto the
    # PathSpec so the virtual path, never the real fs path, is reported.
    try:
        version, raw = await asyncio.to_thread(
            _scan, p, accessor.folder_versions
        )
    except FileNotFoundError as exc:
        raise enoent(path_spec) from exc
    except NotADirectoryError as exc:
        raise enotdir(path_spec) from exc
    except OSError as exc:
        raise disk_error(exc, path_spec.virtual) from exc
    entries = sorted(base.rstrip("/") + "/" + name for name in raw)
    virtual_entries = sorted((prefix + e if prefix else e) for e in entries)
    index_entries = [
        (
            e.rsplit("/", 1)[-1],
            IndexEntry(
                id=e,
                name=e.rsplit("/", 1)[-1],
                resource_type=raw[e.rsplit("/", 1)[-1]],
            ),
        )
        for e in entries
    ]
    await index.set_dir(virtual_key, index_entries, version=version)
    return virtual_entries
