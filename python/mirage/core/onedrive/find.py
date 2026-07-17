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

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.find_eval import PredNode, start_basename
from mirage.core.msgraph.drive_ops import find_items
from mirage.core.onedrive._client import drive_loc, split_path
from mirage.core.onedrive.stat import stat
from mirage.types import FileType, PathSpec


async def _dir_exists(accessor: OneDriveAccessor, path: PathSpec) -> bool:
    try:
        info = await stat(accessor, path, index=NULL_INDEX)
    except FileNotFoundError:
        return False
    return info.type == FileType.DIRECTORY


async def find(
    accessor: OneDriveAccessor,
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
) -> list[str]:
    _, base = split_path(path)
    return await find_items(accessor.config,
                            drive_loc(accessor.config, base),
                            start_basename(path),
                            partial(_dir_exists, accessor, path),
                            name=name,
                            type=type,
                            min_size=min_size,
                            max_size=max_size,
                            maxdepth=maxdepth,
                            name_exclude=name_exclude,
                            or_names=or_names,
                            iname=iname,
                            path_pattern=path_pattern,
                            mindepth=mindepth,
                            empty=empty,
                            tree=tree)
