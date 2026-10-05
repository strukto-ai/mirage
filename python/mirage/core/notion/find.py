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

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.find_eval import FindArgs, PredNode
from mirage.core.generic.find import walk_find
from mirage.core.notion.readdir import readdir
from mirage.core.notion.stat import stat
from mirage.types import FileStat, PathSpec
from mirage.utils.key_prefix import mount_prefix_of


async def find(
    accessor: NotionAccessor,
    path: PathSpec,
    name: str | None = None,
    type: str | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    maxdepth: int | None = None,
    name_exclude: str | None = None,
    or_names: list[str] | None = None,
    mtime_min: float | None = None,
    mtime_max: float | None = None,
    iname: str | None = None,
    path_pattern: str | None = None,
    mindepth: int | None = None,
    empty: bool = False,
    tree: PredNode | None = None,
    *,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    walk_index = RAMIndexCacheStore() if index is NULL_INDEX else index

    async def read_dir(spec: PathSpec, _: IndexCacheStore | None) -> list[str]:
        return await readdir(accessor, spec, walk_index)

    async def stat_entry(
        spec: PathSpec, _: IndexCacheStore | None
    ) -> FileStat:
        return await stat(accessor, spec, walk_index)

    paths = await walk_find(
        path,
        readdir=read_dir,
        stat=stat_entry,
        index=walk_index,
        args=FindArgs(
            name=name,
            type=type,
            min_size=min_size,
            max_size=max_size,
            maxdepth=maxdepth,
            name_exclude=name_exclude,
            or_names=or_names,
            mtime_min=mtime_min,
            mtime_max=mtime_max,
            iname=iname,
            path_pattern=path_pattern,
            mindepth=mindepth,
            empty=empty,
            tree=tree,
        ),
    )
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    return [p.removeprefix(prefix) or "/" for p in paths]
