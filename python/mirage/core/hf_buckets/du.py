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
from mirage.core.hf_buckets.stat import stat
from mirage.types import FileType, PathSpec


async def du(accessor: HfBucketsAccessor, path: PathSpec) -> int:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    try:
        info = await stat(accessor, path)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return info.size or 0
    target = path.strip_prefix
    pfx = target.strip("/")
    scan_path = pfx + "/" if pfx else "/"
    op = accessor.operator()
    total = 0
    try:
        async for entry in await op.scan(scan_path):
            if entry.path.endswith("/"):
                continue
            meta = entry.metadata
            if meta is not None:
                total += int(meta.content_length or 0)
    except NotFound:
        return 0
    return total


async def du_all(accessor: HfBucketsAccessor,
                 path: PathSpec) -> list[tuple[str, int]]:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    try:
        info = await stat(accessor, path)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return []
    target = path.strip_prefix
    pfx = target.strip("/")
    scan_path = pfx + "/" if pfx else "/"
    op = accessor.operator()
    results: list[tuple[str, int]] = []
    total = 0
    try:
        async for entry in await op.scan(scan_path):
            rel = entry.path
            if not rel or rel.endswith("/"):
                continue
            meta = entry.metadata
            sz = int(meta.content_length or 0) if meta is not None else 0
            results.append(("/" + rel.lstrip("/"), sz))
            total += sz
    except NotFound:
        pass
    results.sort()
    results.append((target, total))
    return results
