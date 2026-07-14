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
from mimetypes import guess_type as _guess_mime

from mirage.accessor.gmail import GmailAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.gmail.labels import list_labels
from mirage.core.gmail.readdir import readdir as _readdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import filetype_from_mimetype
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)


def _guess_filetype(filename: str) -> FileType:
    mime, _ = _guess_mime(filename)
    return filetype_from_mimetype(mime or "")


async def stat(
    accessor: GmailAccessor,
    path: PathSpec,
    index: IndexCacheStore | None = None,
) -> FileStat:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path
    if not key:
        return FileStat(name="/", type=FileType.DIRECTORY)
    if index is None:
        raise enoent(virtual)
    virtual_key = prefix + "/" + key if prefix else "/" + key
    result = await index.get(virtual_key)
    if result.entry is None and "/" not in key:
        labels = await list_labels(accessor.token_manager)
        names = {
            lb["id"] if lb.get("type") == "system" else lb.get(
                "name", lb["id"])
            for lb in labels
        }
        if key in names:
            return FileStat(name=key, type=FileType.DIRECTORY)
        raise enoent(virtual)
    if result.entry is None:
        parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
        try:
            await _readdir(
                accessor,
                PathSpec(virtual=parent_virtual,
                         directory=parent_virtual,
                         resource_path=mount_key(parent_virtual, prefix)),
                index=index,
            )
        except Exception as exc:
            # best-effort cache populate; canonical ENOENT raised below
            logger.debug("stat populate failed for %s: %s", virtual_key, exc)
        result = await index.get(virtual_key)
        if result.entry is None:
            raise enoent(virtual)
    rt = result.entry.resource_type
    if rt == "gmail/label":
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.DIRECTORY,
            extra={"label_id": result.entry.id},
        )
    if rt == "gmail/date":
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.DIRECTORY,
        )
    if rt == "gmail/message":
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.JSON,
            size=result.entry.size,
            extra={
                "message_id": result.entry.id,
                **result.entry.extra
            },
        )
    if rt == "gmail/attachment_dir":
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.DIRECTORY,
            extra={"message_id": result.entry.id},
        )
    if rt == "gmail/attachment":
        ft = _guess_filetype(result.entry.vfs_name)
        return FileStat(
            name=result.entry.vfs_name,
            type=ft,
            size=result.entry.size,
            extra={"attachment_id": result.entry.id},
        )
    return FileStat(
        name=result.entry.vfs_name,
        type=FileType.JSON,
        extra={"message_id": result.entry.id},
    )
