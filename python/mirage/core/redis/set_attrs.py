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

from mirage.accessor.redis import RedisAccessor
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.path import norm


async def set_attrs(
    accessor: RedisAccessor,
    path: PathSpec,
    *,
    mode: int | None = None,
    uid: int | str | None = None,
    gid: int | str | None = None,
    atime: str | None = None,
    mtime: str | None = None,
) -> dict[str, int | str]:
    """Write metadata fields on an existing entry (the write side of stat).

    Fields live in a per-path attrs hash; values are stored as strings
    (redis hashes are string-valued) and decoded by stat. Stored, not
    enforced: mount mode does real access control.

    Args:
        accessor (RedisAccessor): backend handle.
        path (PathSpec): target path.
        mode (int | None): permission bits (e.g. 0o644).
        uid (int | str | None): owner id or name.
        gid (int | str | None): group id or name.
        atime (str | None): ISO access time.
        mtime (str | None): ISO modification time.

    Returns:
        dict[str, int | str]: always empty; every field applies natively.
    """
    store = accessor.store
    p = norm(path.mount_path)
    if not (await store.has_file(p) or await store.has_dir(p)):
        raise enoent(path.raw_path)
    fields: dict[str, str] = {}
    if mode is not None:
        fields["mode"] = str(mode)
    if uid is not None:
        fields["uid"] = str(uid)
    if gid is not None:
        fields["gid"] = str(gid)
    if atime is not None:
        fields["atime"] = atime
    if fields:
        await store.set_attrs(p, fields)
    if mtime is not None:
        await store.set_modified(p, mtime)
    return {}
