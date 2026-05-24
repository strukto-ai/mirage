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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.file_helper import _detect
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gdrive.glob import resolve_glob
from mirage.core.gdrive.read import read as gdrive_read
from mirage.core.gdrive.stat import stat as stat_impl
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec

_MIME_MAP: dict[str, str] = {
    "text": "text/plain; charset=us-ascii",
    "json": "application/json; charset=us-ascii",
    "csv": "text/csv; charset=us-ascii",
    "directory": "inode/directory",
    "binary": "application/octet-stream",
    "image/png": "image/png",
    "image/jpeg": "image/jpeg",
    "image/gif": "image/gif",
    "application/zip": "application/zip",
    "application/gzip": "application/gzip",
    "application/pdf": "application/pdf",
    "parquet": "application/octet-stream",
    "orc": "application/octet-stream",
    "feather": "application/octet-stream",
    "hdf5": "application/octet-stream",
}


def _format_file_result(
    path: str,
    result: FileType | str,
    brief: bool,
    mime: bool,
) -> str:
    key = result.value if isinstance(result, FileType) else str(result)
    desc = _MIME_MAP.get(key, key) if mime else key
    if brief:
        return desc
    return f"{path}: {desc}"


@command("file", resource="gdrive", spec=SPECS["file"])
async def file(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    b: bool = False,
    i: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("file: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
    s = await stat_impl(accessor, p, index)
    if s.type == FileType.DIRECTORY:
        result = FileType.DIRECTORY
    else:
        try:
            data = await gdrive_read(accessor, p, index)
            header = data[:512]
        except Exception:
            header = b""
        result = _detect(p.original, header, s)
    return _format_file_result(p.original, result, b, i).encode(), IOResult()
