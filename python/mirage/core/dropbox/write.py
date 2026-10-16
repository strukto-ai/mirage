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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import native_condition, write_condition
from mirage.core.dropbox.api import lookup, refused
from mirage.core.dropbox.client import DropboxApiError, dropbox_upload
from mirage.core.dropbox.fingerprint import live_of
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.core.dropbox.readdir import stat_from_entry
from mirage.io.spool import ByteSpool
from mirage.io.types import ByteSource
from mirage.observe.context import record, start_op
from mirage.types import FileStat, PathSpec
from mirage.utils.upload import upload_stat


async def write(
    accessor: DropboxAccessor, path: PathSpec, data: bytes | ByteSpool
) -> FileStat | None:
    """Upload a body, using sessions for large spooled inputs.

    A held version costs one get_metadata and goes out as the file's rev
    in ``update`` mode.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): target path.
        data (bytes): file content.

    Returns:
        FileStat | None: the stored file's stat, None for a reply that
            names none.
    """
    tm = accessor.token_manager
    api_path = dropbox_path_of(accessor, path)
    cond = await write_condition(path, "put")
    rev = None
    if cond is not None and cond.if_match:
        live = live_of(await lookup(tm, api_path))
        rev = await native_condition(path, cond, live, "put")
    timer = start_op()
    try:
        entry = await dropbox_upload(tm, api_path, data, rev)
    except DropboxApiError as exc:
        raise (await refused(path, exc, cond, rev)) or exc
    stored = upload_stat(entry, stat_from_entry, path.virtual)
    record(
        "write",
        path.virtual,
        "dropbox",
        data.size if isinstance(data, ByteSpool) else len(data),
        timer,
        fingerprint=None if stored is None else stored.fingerprint,
    )
    return stored


async def write_stream(
    accessor: DropboxAccessor, path: PathSpec, data: ByteSource
) -> FileStat | None:
    async with ByteSpool() as spool:
        await spool.fill(data)
        return await write(accessor, path, spool)
