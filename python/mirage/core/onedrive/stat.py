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

import logging

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.core.msgraph.client import GraphError, graph_get
from mirage.core.msgraph.drive import (
    batch_tree,
    delta_tree,
    folder_child_count,
    stat_item,
    virtual_key,
)
from mirage.core.onedrive.client import drive_base, drive_loc
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec

logger = logging.getLogger(__name__)


async def stat(accessor: OneDriveAccessor, path: PathSpec) -> FileStat:
    if not path.vfs_path:
        # The mount root is a real Graph item (`/drive/root` or the
        # key_prefix folder); fetch it so modified is populated instead of
        # synthesizing a bare directory stat. Its `size` is Graph's
        # aggregate subtree storage number, not rendered content length:
        # expose it as extra, like every other folder (see entry_stat).
        try:
            item = await graph_get(
                accessor, drive_loc(accessor.config, "").item()
            )
        except GraphError as exc:
            if exc.status == 404:
                raise enoent(path)
            raise
        return FileStat(
            name="/",
            type=FileType.DIRECTORY,
            modified=item.get("lastModifiedDateTime"),
            extra={
                "size_bytes": item.get("size"),
                "child_count": folder_child_count(item),
            },
        )
    return await stat_item(
        accessor, drive_loc(accessor.config, path.vfs_path), path.virtual
    )


async def tree(
    accessor: OneDriveAccessor, path: PathSpec, limit: int | None = None
) -> dict[str, FileStat] | None:
    """Every item under a folder, each as a listing's stat renders it.

    A personal drive answers from one read of Graph's ``/delta`` feed
    (``delta_tree``): it starts the feed at any folder and carries each
    file's ``cTag``, the token its listing row holds. OneDrive for
    Business starts the feed only at the drive root and leaves the
    ``cTag`` out, so its folders' listings go out batched instead
    (``batch_tree``), as they do for a feed that does not answer and for
    a drive that will not say which kind it is. Which kind the drive is,
    Graph's ``driveType``, is asked once per mount. A walk's ``limit``
    goes to the batched listings, which stop past it, since the feed
    cannot be cut.

    Args:
        accessor (OneDriveAccessor): backend accessor.
        path (PathSpec): the directory.
        limit (int | None): the most entries a walk can still keep.
    """
    config = accessor.config
    loc = drive_loc(config, path.vfs_path)
    if limit is None and await _drive_type(accessor) == "personal":
        found = await delta_tree(accessor, loc)
        if found is not None:
            return found
    return await batch_tree(accessor, loc, virtual_key(path), limit)


async def _drive_type(accessor: OneDriveAccessor) -> str:
    """The drive's Graph ``driveType``, asked on first use and kept; ""
    while Graph refuses to say, which is asked again next time.

    Args:
        accessor (OneDriveAccessor): backend accessor.
    """
    if accessor.drive_type is None:
        try:
            drive = await graph_get(
                accessor,
                drive_base(accessor.config),
                params={"$select": "driveType"},
            )
        except GraphError as exc:
            logger.debug("onedrive drive type unanswered: %s", exc)
            return ""
        accessor.drive_type = str(drive.get("driveType") or "")
    return accessor.drive_type
