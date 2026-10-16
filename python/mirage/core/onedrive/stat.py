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
from mirage.core.msgraph.drive import delta_tree, folder_child_count, stat_item
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
                accessor.config,
                drive_loc(accessor.config, "").item(),
                session=accessor.pool,
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
        accessor.config,
        drive_loc(accessor.config, path.vfs_path),
        path.virtual,
        session=accessor.pool,
    )


async def tree(
    accessor: OneDriveAccessor, path: PathSpec
) -> dict[str, FileStat] | None:
    """Every item under a folder, each as a listing's stat renders it, from
    one read of Graph's ``/delta`` feed (``delta_tree``).

    Only a personal drive answers: it starts the feed at any folder and
    carries each file's ``cTag``, the token its listing row holds.
    OneDrive for Business starts the feed only at the drive root and leaves
    the ``cTag`` out, so its walk lists each folder. Which kind the drive
    is, Graph's ``driveType``, is asked once per mount. None hands the
    folder to the walk, as does a drive that will not say which kind it is.

    Args:
        accessor (OneDriveAccessor): backend accessor.
        path (PathSpec): the directory.
    """
    config = accessor.config
    if await _drive_type(accessor) != "personal":
        return None
    return await delta_tree(
        config, drive_loc(config, path.vfs_path), session=accessor.pool
    )


async def _drive_type(accessor: OneDriveAccessor) -> str:
    """The drive's Graph ``driveType``, asked on first use and kept; ""
    while Graph refuses to say, which is asked again next time.

    Args:
        accessor (OneDriveAccessor): backend accessor.
    """
    if accessor.drive_type is None:
        try:
            drive = await graph_get(
                accessor.config,
                drive_base(accessor.config),
                params={"$select": "driveType"},
                session=accessor.pool,
            )
        except GraphError as exc:
            logger.debug("onedrive drive type unanswered: %s", exc)
            return ""
        accessor.drive_type = str(drive.get("driveType") or "")
    return accessor.drive_type
