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


def _from_fields(
    p: str,
    is_dir: bool,
    raw: dict[str, str],
    size: int | None,
    modified: str | None,
) -> FileStat:
    """The stat of the normalized key ``p`` from what the store holds
    for it.

    Args:
        p (str): the normalized key.
        is_dir (bool): whether ``p`` is a directory.
        raw (dict[str, str]): its stored attributes.
        size (int | None): its length, None for a directory.
        modified (str | None): its stored modified time.
    """
    attrs = _decode_attrs(raw)
    if is_dir:
        return FileStat(
            name=p.rsplit("/", 1)[-1] or "/",
            size=None,
            modified=modified,
            type=FileType.DIRECTORY,
            mode=attrs.get("mode"),
            uid=attrs.get("uid"),
            gid=attrs.get("gid"),
            atime=attrs.get("atime"),
        )
    return FileStat(
        name=p.rsplit("/", 1)[-1],
        size=size,
        modified=modified,
        type=FileType.FILE,
        content=content_type_for_path(p),
        mode=attrs.get("mode"),
        uid=attrs.get("uid"),
        gid=attrs.get("gid"),
        atime=attrs.get("atime"),
    )


async def key_stats(
    store: RedisStore, keys: list[tuple[str, bool]]
) -> list[FileStat]:
    """What ``stat`` answers for each normalized key the store holds, in
    one pipeline.

    Args:
        store (RedisStore): the mount's store.
        keys (list[tuple[str, bool]]): each normalized key, and whether
            it is a directory.
    """
    fields = await store.stat_many(keys)
    return [
        _from_fields(p, is_dir, *held)
        for (p, is_dir), held in zip(keys, fields, strict=True)
    ]


async def stat(
    accessor: RedisAccessor,
    path_spec: PathSpec,
) -> FileStat:
    """What is at a path, asked in one round trip: whether a directory or
    a file is there and the fields either keeps under its name go out in
    one pipeline (``stat_at``), rather than each waiting for the one
    before, and on one connection, so a pool of one still answers.

    Args:
        accessor (RedisAccessor): the mount's store.
        path_spec (PathSpec): the path.
    """
    store = accessor.store
    p = norm(path_spec.mount_path)
    is_dir, is_file, raw, size, modified = await store.stat_at(p)
    if is_dir:
        return _from_fields(p, True, raw, None, modified)
    if is_file:
        return _from_fields(p, False, raw, size, modified)
    raise await lookup_error(store, path_spec, p)
