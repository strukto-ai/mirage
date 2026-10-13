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

from typing import Any

from mirage.accessor.redis import RedisAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.redis.dest import lookup_error
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import content_type_for_path
from mirage.utils.path import norm
from mirage.vfs.redis.store import RedisStore


def _decode_attrs(raw: dict[str, str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "mode" in raw:
        out["mode"] = int(raw["mode"])
    for key in ("uid", "gid"):
        if key in raw:
            val = raw[key]
            out[key] = int(val) if val.isdigit() else val
    if "atime" in raw:
        out["atime"] = raw["atime"]
    return out


async def key_stat(store: RedisStore, p: str, is_dir: bool) -> FileStat:
    """What ``stat`` answers for the normalized key ``p`` the store holds.

    Args:
        store (RedisStore): the mount's store.
        p (str): the normalized key.
        is_dir (bool): whether ``p`` is a directory.
    """
    attrs = _decode_attrs(await store.get_attrs(p))
    if is_dir:
        return FileStat(
            name=p.rsplit("/", 1)[-1] or "/",
            size=None,
            modified=await store.get_modified(p),
            type=FileType.DIRECTORY,
            mode=attrs.get("mode"),
            uid=attrs.get("uid"),
            gid=attrs.get("gid"),
            atime=attrs.get("atime"),
        )
    return FileStat(
        name=p.rsplit("/", 1)[-1],
        size=await store.file_len(p),
        modified=await store.get_modified(p),
        type=FileType.FILE,
        content=content_type_for_path(p),
        mode=attrs.get("mode"),
        uid=attrs.get("uid"),
        gid=attrs.get("gid"),
        atime=attrs.get("atime"),
    )


async def stat(
    accessor: RedisAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    store = accessor.store
    p = norm(path_spec.mount_path)
    if await store.has_dir(p):
        return await key_stat(store, p, True)
    if await store.has_file(p):
        return await key_stat(store, p, False)
    raise await lookup_error(store, path_spec, p)
