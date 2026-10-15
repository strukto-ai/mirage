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

from mirage.accessor.box import BoxAccessor
from mirage.core.box.api import absent_on_404, list_folder_items
from mirage.core.box.constants import SHA1
from mirage.core.box.fingerprint import token_of
from mirage.core.box.resolve import root_id
from mirage.errors.fs import enoent, enotdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import content_type_for_path


def resource_type_for(item: dict[str, Any]) -> str:
    if item.get("type") == "folder":
        return "box/folder"
    if item.get("type") == "web_link":
        return "box/weblink"
    return "box/file"


def stat_from_item(item: dict[str, Any]) -> FileStat:
    """The stat of one Box item, as a listing, ``GET /files/{id}`` or an
    upload's reply returns it.

    ``extra`` carries what the functions handed the stat act on: the item
    id, and for a file the sha1 a read checks and the etag a conditional
    write sends.

    Args:
        item (dict[str, Any]): a Box item.
    """
    vfs_name = item["name"]
    rt = resource_type_for(item)
    if rt == "box/folder":
        return FileStat(
            name=vfs_name,
            type=FileType.DIRECTORY,
            modified=item.get("modified_at") or "",
            extra={"box_id": item["id"]},
        )
    sha1 = token_of(item.get(SHA1))
    etag = token_of(item.get("etag"))
    return FileStat(
        name=vfs_name,
        size=item.get("size"),
        type=FileType.FILE,
        content=content_type_for_path(vfs_name),
        modified=item.get("modified_at") or "",
        fingerprint=sha1,
        extra={
            "box_id": item["id"],
            "resource_type": rt,
            **({SHA1: sha1} if sha1 else {}),
            **({"etag": etag} if etag else {}),
        },
    )


async def readdir(
    accessor: BoxAccessor,
    path_spec: PathSpec,
    entry: FileStat | None = None,
) -> list[FileStat]:
    """A folder's children, each as ``stat`` answers it.

    The mount root lists its root folder; any other folder is listed by
    the id its parent's listing named. Web links are bookmarks with no
    content endpoint and no size, so they are left out.

    Args:
        accessor (BoxAccessor): Box accessor.
        path_spec (PathSpec): the folder.
        entry (FileStat | None): what is at the folder.
    """
    target = path_spec.dir if path_spec.pattern else path_spec
    if not target.vfs_path.strip("/"):
        folder_id = root_id(accessor)
    elif entry is None:
        raise enoent(path_spec.virtual)
    elif entry.type is not FileType.DIRECTORY:
        raise enotdir(path_spec.virtual)
    else:
        folder_id = entry.extra["box_id"]
    items = await absent_on_404(
        path_spec.virtual,
        lambda: list_folder_items(accessor.token_manager, folder_id),
    )
    rows = [
        stat_from_item(item)
        for item in items
        if item.get("type") != "web_link"
    ]
    rows.sort(key=lambda row: row.name)
    return rows
