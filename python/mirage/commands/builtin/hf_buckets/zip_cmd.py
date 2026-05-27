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

import io
import posixpath
import zipfile
from collections.abc import AsyncIterator

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.hf_buckets.glob import resolve_glob
from mirage.core.hf_buckets.read import read_bytes
from mirage.core.hf_buckets.write import write_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("zip", resource="hf_buckets", spec=SPECS["zip"], write=True)
async def zip_cmd(
    accessor: HfBucketsAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    j: bool = False,
    q: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) < 2:
        raise ValueError("zip: usage: zip archive.zip file1 [file2 ...]")
    paths = await resolve_glob(accessor, paths, index)
    archive_path = paths[0]
    file_paths = paths[1:]
    buf = io.BytesIO()
    output_lines: list[str] = []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in file_paths:
            data = await read_bytes(accessor, p)
            arcname = (posixpath.basename(p.original)
                       if j else p.original.lstrip("/"))
            zf.writestr(arcname, data)
            if not q:
                output_lines.append(f"  adding: {arcname}")
    archive = buf.getvalue()
    await write_bytes(accessor, archive_path, archive)
    stdout = ("\n".join(output_lines) +
              "\n").encode() if output_lines else None
    return stdout, IOResult(writes={archive_path.original: archive})
