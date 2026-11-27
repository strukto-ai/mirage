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

from mirage.accessor.ram import RAMAccessor
from mirage.core.ram.dest import lookup_error
from mirage.core.ram.fingerprint import token_of
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import content_type_for_path
from mirage.utils.path import norm
from mirage.vfs.ram.store import RAMDirs, RAMStore


def subdir_count(store: RAMStore, p: str) -> int:
    """How many folders sit directly in the folder at key ``p``.

    Args:
        store (RAMStore): the mount's store.
        p (str): the folder's normalized key.
    """
    if isinstance(store.dirs, RAMDirs):
        return store.dirs.subdirs.get(p, 0)
    prefix = p.rstrip("/") + "/"
    return sum(
        1
        for key in store.dirs
        if key.startswith(prefix)
        and key != p
        and "/" not in key[len(prefix) :]
    )


def key_stat(store: RAMStore, p: str) -> FileStat | None:
    """What ``stat`` answers for the normalized key ``p``, None when
    nothing is there.

    Args:
        store (RAMStore): the mount's store.
        p (str): the normalized key.
    """
    attrs = store.attrs.get(p, {})
    if p in store.dirs:
        return FileStat(
            name=p.rsplit("/", 1)[-1] or "/",
            size=None,
            modified=store.modified.get(p, store.made),
            type=FileType.DIRECTORY,
            mode=attrs.get("mode"),
            uid=attrs.get("uid"),
            gid=attrs.get("gid"),
            atime=attrs.get("atime"),
            nlink=2 + subdir_count(store, p),
        )
    if p in store.files:
        return FileStat(
            name=p.rsplit("/", 1)[-1],
            size=store.files.size(p),
            modified=store.modified.get(p),
            fingerprint=token_of(store, p),
            type=FileType.FILE,
            content=content_type_for_path(p),
            mode=attrs.get("mode"),
            uid=attrs.get("uid"),
            gid=attrs.get("gid"),
            atime=attrs.get("atime"),
            nlink=1,
        )
    return None


async def stat(
    accessor: RAMAccessor,
    path_spec: PathSpec,
) -> FileStat:
    store = accessor.store
    p = norm(path_spec.mount_path)
    found = key_stat(store, p)
    if found is None:
        raise lookup_error(store, path_spec, p)
    return found
