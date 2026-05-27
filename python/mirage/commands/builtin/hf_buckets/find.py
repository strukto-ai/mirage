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
from mirage.commands.builtin.find_helper import (_extract_not_name,
                                                 _extract_or_names,
                                                 _parse_mtime, _parse_size)
from mirage.commands.builtin.hf_buckets._provision import metadata_provision
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.hf_buckets.find import find as find_impl
from mirage.core.hf_buckets.glob import resolve_glob
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("find",
         resource="hf_buckets",
         spec=SPECS["find"],
         provision=metadata_provision)
async def find(
    accessor: HfBucketsAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    name: str | None = None,
    type: str | None = None,
    maxdepth: str | None = None,
    size: str | None = None,
    mtime: str | None = None,
    iname: str | None = None,
    path: str | None = None,
    mindepth: str | None = None,
    prefix: str = "",
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_glob(accessor, paths, index)
    path_pattern = path
    p0 = paths[0]
    search_path = p0
    ftype = None
    if type == "d":
        ftype = "directory"
    elif type == "f":
        ftype = "file"
    elif type is not None:
        ftype = type
    md = int(maxdepth) if maxdepth is not None else None
    min_size, max_size = (None, None)
    if size is not None:
        min_size, max_size = _parse_size(size)
    mtime_min, mtime_max = (None, None)
    if mtime is not None:
        mtime_min, mtime_max = _parse_mtime(mtime)
    name_exclude = _extract_not_name(texts)
    or_names = _extract_or_names(name, texts)
    md_min = int(mindepth) if mindepth is not None else None
    results = await find_impl(
        accessor,
        search_path,
        name=name,
        type=ftype,
        min_size=min_size,
        max_size=max_size,
        maxdepth=md,
        name_exclude=name_exclude,
        or_names=or_names if len(or_names) > 1 else None,
        mtime_min=mtime_min,
        mtime_max=mtime_max,
        iname=iname,
        path_pattern=path_pattern,
        mindepth=md_min,
    )
    if p0.prefix:
        results = [p0.prefix + "/" + r.lstrip("/") for r in results]
    output = "\n".join(results).encode()
    return output, IOResult()
