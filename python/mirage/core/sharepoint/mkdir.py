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

import posixpath

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.context import invalidate_after_write, invalidate_ancestors
from mirage.core.msgraph.drive import FolderTarget, create_child_folder
from mirage.core.sharepoint.client import item_url
from mirage.core.sharepoint.resolve import resolve_item
from mirage.types import PathSpec
from mirage.utils.errors import enotdir


async def _create_dir(
    accessor: SharePointAccessor, drive_id: str, path: str, virtual: str
) -> None:
    config = accessor.config
    parent = posixpath.dirname(path)
    await create_child_folder(
        config,
        item_url(config, drive_id, parent, action="/children"),
        posixpath.basename(path),
        FolderTarget(
            item=item_url(config, drive_id, path),
            parent=item_url(config, drive_id, parent),
            virtual=virtual,
        ),
        session=accessor.pool,
    )


async def _create_chain(
    accessor: SharePointAccessor,
    drive_id: str,
    item_path: str,
    virtual: str,
    parents: bool,
) -> None:
    """Create every level of a drive path, from the drive root down.

    Args:
        accessor (SharePointAccessor): the mount's accessor.
        drive_id (str): the drive the path lives in.
        item_path (str): the drive-relative path, key_prefix included.
        virtual (str): the operand's virtual path.
        parents (bool): name a file in the way rather than the operand.
    """
    parts = item_path.split("/")
    for i in range(len(parts)):
        try:
            await _create_dir(
                accessor, drive_id, "/".join(parts[: i + 1]), virtual
            )
        except FileExistsError as exc:
            above = len(parts) - 1 - i
            if not above:
                raise
            # `mkdir -p` names the file it stops at, as GNU does; mkdir(2)
            # blames the operand.
            level = virtual.rstrip("/").rsplit("/", above)[0] or "/"
            raise enotdir(level if parents else virtual) from exc


def _scoped_prefix(accessor: SharePointAccessor) -> str:
    """The key_prefix a scoped mount's root folder chain lives at.

    Only a mount scoped to one site and drive places its paths under the
    prefix, so only there is the mount root a folder chain that a folder
    create can find missing. With parents the chain is already walked;
    without, a create right under the root has to make it first.

    Args:
        accessor (SharePointAccessor): the mount's accessor.
    """
    config = accessor.config
    if config.site is None or config.drive is None:
        return ""
    return (config.key_prefix or "").strip("/")


async def mkdir(
    accessor: SharePointAccessor, path: PathSpec, parents: bool = False
) -> None:
    if not path.vfs_path:
        return
    resolved = await resolve_item(accessor, path)
    drive_id = resolved.drive_id or ""
    item_path = resolved.item_path or ""
    if parents:
        await _create_chain(
            accessor, drive_id, item_path, path.virtual, parents=True
        )
    else:
        try:
            await _create_dir(accessor, drive_id, item_path, path.virtual)
        except FileNotFoundError:
            prefix = _scoped_prefix(accessor)
            if not prefix or posixpath.dirname(item_path) != prefix:
                raise
            await _create_chain(
                accessor, drive_id, item_path, path.virtual, parents=False
            )
    await invalidate_after_write(path)
    if parents:
        await invalidate_ancestors(path)
