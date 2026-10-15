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

from datetime import datetime

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.resolve import eacces_on_denied, resolve_key
from mirage.core.google.drive import patch_file
from mirage.errors.fs import enoent
from mirage.types import PathSpec
from mirage.utils.dates import to_iso_z


@eacces_on_denied
async def set_attrs(
    accessor: GDriveAccessor,
    path: PathSpec,
    *,
    mode: int | None = None,
    uid: int | str | None = None,
    gid: int | str | None = None,
    atime: str | None = None,
    mtime: str | None = None,
) -> dict[str, int | str]:
    """Store a modified time as the item's Drive ``modifiedTime``, and
    return the fields Drive does not keep: permission bits, ownership
    and the access time land in the namespace's overlay, and so does a
    time for the mount root, which is no item of the mount's own.

    Args:
        accessor (GDriveAccessor): backend accessor.
        path (PathSpec): the file or folder.
        mode (int | None): permission bits.
        uid (int | str | None): owner.
        gid (int | str | None): group.
        atime (str | None): ISO access time.
        mtime (str | None): ISO modification time.
    """
    residual: dict[str, int | str] = {}
    for key, value in (("mode", mode), ("uid", uid), ("gid", gid)):
        if value is not None:
            residual[key] = value
    if atime is not None:
        residual["atime"] = atime
    if mtime is None:
        return residual
    if not path.vfs_path.strip("/"):
        residual["mtime"] = mtime
        return residual
    node = await resolve_key(accessor, path.vfs_path)
    if node is None:
        raise enoent(path)
    await patch_file(
        accessor.token_manager,
        node.id,
        {"modifiedTime": to_iso_z(datetime.fromisoformat(mtime))},
    )
    return residual
