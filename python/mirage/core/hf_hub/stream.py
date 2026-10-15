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

from collections.abc import AsyncIterator, Mapping

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.core.hf_hub.client import hub_stream, resolve_url
from mirage.core.hf_hub.constants import DEFAULT_CHUNK_SIZE, REFUSED_STATUSES
from mirage.core.hf_hub.lookup import refusals_denied
from mirage.core.hf_hub.read import resolve_entry, row_token
from mirage.observe.context import record_stream
from mirage.types import FileStat, PathSpec


async def read_stream(
    accessor: HfHubAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> AsyncIterator[bytes]:
    """Stream a file's content.

    Args:
        accessor (HfHubAccessor): backend handle.
        path (PathSpec): the file to read.
        entry (FileStat | None): the file's row.
        chunk_size (int): bytes per yielded chunk.

    Yields:
        bytes: the next chunk of content.
    """
    row = resolve_entry(path, entry)
    raw = path.mount_path
    url = resolve_url(
        accessor.endpoint,
        accessor.repo_type,
        accessor.repo_id,
        accessor.revision,
        accessor.repo_path(raw),
    )
    rec = record_stream("read", path.virtual, accessor.VFS_NAME)

    def stamp(headers: Mapping[str, str]) -> None:
        if rec is not None:
            rec.fingerprint = row_token(row, headers.get("etag", ""))

    with refusals_denied(path, REFUSED_STATUSES):
        async for chunk in hub_stream(
            accessor.token,
            url,
            chunk_size,
            session=accessor.pool,
            on_response=stamp,
        ):
            if rec is not None:
                rec.bytes += len(chunk)
            yield chunk
