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

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.cache.context import invalidate_after_write, invalidate_ancestors
from mirage.core.msgraph.drive import FolderTarget, create_child_folder
from mirage.core.onedrive.client import full_item_url, item_url
from mirage.types import PathSpec
from mirage.utils.errors import enotdir
from mirage.utils.key_prefix import mount_prefix_of


async def _create_root(accessor: OneDriveAccessor, root: str) -> None:
    """Create the mount's ``key_prefix`` folders, one level at a time.

    The mount root exists from the agent's side because it is mounted, but
    on the drive it is a folder chain nothing has created until the first
    write. A file upload creates its parents; a folder create does not,
    so mkdir has to. The prefix is hidden, so a file in it is named as
    ``root``: the mount root is then not a directory.

    Args:
        accessor (OneDriveAccessor): the mount's accessor.
        root (str): the path a refusal in the prefix names.
    """
    parent = ""
    for name in (accessor.config.key_prefix or "").strip("/").split("/"):
        level = f"{parent}/{name}" if parent else name
        try:
            await create_child_folder(
                accessor.config,
                full_item_url(accessor.config, parent, action="/children"),
                name,
                FolderTarget(
                    item=full_item_url(accessor.config, level),
                    parent=full_item_url(accessor.config, parent),
                    virtual=root,
                ),
                session=accessor.pool,
            )
        except FileExistsError as exc:
            raise enotdir(root) from exc
        parent = level


async def _create_dir(
    accessor: OneDriveAccessor, path: str, virtual: str, root: str
) -> None:
    config = accessor.config
    parent = posixpath.dirname(path)

    async def create() -> None:
        await create_child_folder(
            config,
            item_url(config, parent, action="/children"),
            posixpath.basename(path),
            FolderTarget(
                item=item_url(config, path),
                parent=item_url(config, parent),
                virtual=virtual,
            ),
            session=accessor.pool,
        )

    try:
        await create()
    except FileNotFoundError:
        if parent or not (config.key_prefix or "").strip("/"):
            raise
        await _create_root(accessor, root)
        await create()


async def mkdir(
    accessor: OneDriveAccessor, path: PathSpec, parents: bool = False
) -> None:
    key = path.vfs_path
    if not key:
        return
    if parents:
        prefix = mount_prefix_of(path.virtual, path.vfs_path).rstrip("/")
        parts = key.split("/")
        for i in range(len(parts)):
            level = "/".join(parts[: i + 1])
            virtual = f"{prefix}/{level}"
            try:
                await _create_dir(accessor, level, virtual, prefix or "/")
            except FileExistsError as exc:
                # `mkdir -p` passes only a directory at the operand and
                # names the file it stops at above it, as GNU does.
                if i == len(parts) - 1:
                    raise
                raise enotdir(virtual) from exc
    else:
        await _create_dir(accessor, key, path.virtual, path.virtual)
    await invalidate_after_write(path)
    if parents:
        await invalidate_ancestors(path)
