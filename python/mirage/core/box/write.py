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

from mirage.accessor.box import BoxAccessor
from mirage.cache.context import (
    evict_after,
    invalidate_after_write,
    native_condition,
    write_condition,
)
from mirage.core.box.api import refused, upload_file_version, upload_new_file
from mirage.core.box.client import BoxApiError
from mirage.core.box.fingerprint import live_of
from mirage.core.box.resolve import path_parts, resolve_item, resolve_parent_id
from mirage.core.box.stat import stat_from_item
from mirage.errors.fs import eisdir, enoent
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.upload import upload_token


async def write(accessor: BoxAccessor, path: PathSpec, data: bytes) -> None:
    """Upload a new file, or a new version of an existing one.

    A failed upload still evicts the path: Box may have stored the bytes
    before its reply broke off. A held version goes out as the file's etag.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): target path.
        data (bytes): file content.
    """
    parts = path_parts(path)
    if not parts:
        raise eisdir(path.virtual)
    tm = accessor.token_manager
    cond = await write_condition(path, "put")
    timer = start_op()
    existing = await resolve_item(accessor, parts)
    etag = await native_condition(path, cond, live_of(existing), "put")
    if existing is not None and existing.get("type") == "file":
        # Overwrite uploads a new version under the same id, keeping Box's
        # own name so a box-native file isn't renamed with the vfs suffix.
        upload = upload_file_version(
            tm, existing["id"], existing["name"], data, etag
        )
    else:
        parent_id = await resolve_parent_id(accessor, parts)
        if parent_id is None:
            raise enoent(path.virtual)
        upload = upload_new_file(tm, parent_id, parts[-1], data)

    async def send() -> None:
        reply = await upload
        entries = reply.get("entries") if isinstance(reply, dict) else None
        item = entries[0] if isinstance(entries, list) and entries else None
        token = upload_token(item, stat_from_item, path.virtual)
        record(
            "write", path.virtual, "box", len(data), timer, fingerprint=token
        )

    try:
        await evict_after(send(), lambda _: invalidate_after_write(path))
    except BoxApiError as exc:
        raise (await refused(path, exc, cond, etag)) or exc
