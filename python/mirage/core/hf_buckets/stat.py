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
from mirage.cache.index import IndexCacheStore
from mirage.core.hf_buckets._client import (HfBucketsClient, _key, _prefix,
                                            _resolve_url, _tree_url)
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import guess_type


async def stat(accessor: HfBucketsAccessor,
               path: PathSpec,
               index: IndexCacheStore | None = None) -> FileStat:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    original_prefix = path.prefix
    raw = path.original
    if original_prefix and raw.startswith(original_prefix):
        raw = raw[len(original_prefix):] or "/"
    stripped = raw.strip("/")
    if not stripped:
        return FileStat(name="/", type=FileType.DIRECTORY)
    config = accessor.config
    key = _key(raw, config)
    client = HfBucketsClient(config)
    bucket_id = await client.bucket_id()
    file_url = _resolve_url(config.endpoint, bucket_id, key)
    async with await client.session() as session:
        async with session.head(file_url, allow_redirects=True) as resp:
            if resp.status == 200:
                size = int(resp.headers.get("Content-Length", "0"))
                # TODO: confirm Xet hash header name against real HF response.
                xet = resp.headers.get("X-Xet-Hash")
                return FileStat(
                    name=stripped.rsplit("/", 1)[-1],
                    size=size,
                    modified=resp.headers.get("Last-Modified"),
                    type=guess_type(raw),
                    fingerprint=xet,
                    extra={"xet_hash": xet} if xet else {},
                )
            if resp.status != 404:
                resp.raise_for_status()
                # Any 2xx other than 200 we treat as "unexpected, not a directory."
                raise FileNotFoundError(raw)
        tree_url = _tree_url(config.endpoint, bucket_id, _prefix(raw, config))
        async with session.get(tree_url) as tresp:
            if tresp.status == 200:
                entries = await tresp.json()
                if entries:
                    return FileStat(
                        name=stripped.rsplit("/", 1)[-1] or "/",
                        type=FileType.DIRECTORY,
                    )
    raise FileNotFoundError(raw)
