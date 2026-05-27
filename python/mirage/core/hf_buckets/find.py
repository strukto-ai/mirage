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

from opendal.exceptions import NotFound

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.types import PathSpec


async def find(
    accessor: HfBucketsAccessor,
    path: PathSpec,
    index: IndexCacheStore | None = None,
) -> list[str]:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    target = path.strip_prefix
    pfx = target.strip("/")
    scan_path = pfx + "/" if pfx else "/"
    op = accessor.operator()
    results: list[str] = []
    try:
        async for entry in await op.scan(scan_path):
            rel = entry.path
            if not rel or rel.endswith("/"):
                continue
            results.append("/" + rel.lstrip("/"))
    except NotFound:
        return []
    return sorted(results)
