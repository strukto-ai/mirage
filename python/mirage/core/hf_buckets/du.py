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

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.core.hf_buckets._client import (HfBucketsClient, _prefix,
                                            _strip_prefix, _tree_url)
from mirage.types import PathSpec


async def du(accessor: HfBucketsAccessor, path: PathSpec) -> int:
    """Total size in bytes under a prefix.

    Args:
        accessor (HfBucketsAccessor): HF buckets accessor.
        path (PathSpec | str): Prefix path.
    """
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    target = path.strip_prefix
    config = accessor.config
    pfx = _prefix(target, config).rstrip("/")
    client = HfBucketsClient(config)
    bucket_id = await client.bucket_id()
    url = _tree_url(config.endpoint, bucket_id, pfx)
    total = 0
    async with await client.session() as session:
        async with session.get(url, params={"recursive": "true"}) as resp:
            resp.raise_for_status()
            entries_json = await resp.json()
    for entry in entries_json:
        if entry.get("type") == "directory":
            continue
        total += int(entry.get("size", 0) or 0)
    return total


async def du_all(accessor: HfBucketsAccessor,
                 path: PathSpec) -> list[tuple[str, int]]:
    """List of (path, size) tuples plus a trailing total entry.

    Args:
        accessor (HfBucketsAccessor): HF buckets accessor.
        path (PathSpec | str): Prefix path.
    """
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    target = path.strip_prefix
    config = accessor.config
    pfx = _prefix(target, config).rstrip("/")
    client = HfBucketsClient(config)
    bucket_id = await client.bucket_id()
    url = _tree_url(config.endpoint, bucket_id, pfx)
    results: list[tuple[str, int]] = []
    total = 0
    async with await client.session() as session:
        async with session.get(url, params={"recursive": "true"}) as resp:
            resp.raise_for_status()
            entries_json = await resp.json()
    for entry in entries_json:
        if entry.get("type") == "directory":
            continue
        bucket_key = entry.get("path", "")
        if not bucket_key:
            continue
        sz = int(entry.get("size", 0) or 0)
        results.append(("/" + _strip_prefix(bucket_key, config), sz))
        total += sz
    results.sort()
    results.append((target, total))
    return results
