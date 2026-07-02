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

from functools import partial

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.find import parse_find_args, walk_find
from mirage.commands.builtin.mongodb._provision import metadata_provision
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.mongodb.glob import resolve_glob
from mirage.core.mongodb.readdir import is_dir_name
from mirage.core.mongodb.readdir import readdir as _readdir
from mirage.core.mongodb.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of


@command("find",
         resource="mongodb",
         spec=SPECS["find"],
         provision=metadata_provision)
async def find(
    accessor: MongoDBAccessor,
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
    paths = await resolve_glob(accessor, paths, index=index)
    p0 = paths[0] if paths else None
    search_path = p0.virtual if p0 else "/"
    search_prefix = mount_prefix_of(p0.virtual, p0.resource_path) if p0 else ""
    args = parse_find_args(texts,
                           name=name,
                           type=type,
                           size=size,
                           mtime=mtime,
                           maxdepth=maxdepth,
                           iname=iname,
                           path=path,
                           mindepth=mindepth)
    search_spec = PathSpec(virtual=search_path,
                           directory=search_path,
                           resolved=False,
                           resource_path=mount_key(search_path, search_prefix))
    results = await walk_find(search_spec,
                              readdir=partial(_readdir, accessor),
                              stat=partial(_stat, accessor),
                              is_dir_name=is_dir_name,
                              index=index,
                              args=args)
    output = format_records(results)
    return output, IOResult()
