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


@command("unzip", resource="hf_buckets", spec=SPECS["unzip"], write=True)
async def unzip(
    accessor: HfBucketsAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    o: bool = False,
    args_l: bool = False,
    d: str | None = None,
    q: bool = False,
    p: bool = False,
    t: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("unzip: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    archive_path = paths[0]
    data = await read_bytes(accessor, archive_path)
    with zipfile.ZipFile(io.BytesIO(data), "r") as zf:
        if args_l:
            lines = ["  Length      Name", "---------  ----"]
            for info in zf.infolist():
                lines.append(f"{info.file_size:>9}  {info.filename}")
            return ("\n".join(lines) + "\n").encode(), IOResult()
        if t:
            bad = zf.testzip()
            if bad is None:
                msg = f"No errors detected in {archive_path.original}\n"
            else:
                msg = f"first bad file: {bad}\n"
            return msg.encode(), IOResult()
        if p:
            chunks: list[bytes] = []
            for info in zf.infolist():
                if not info.is_dir():
                    chunks.append(zf.read(info.filename))
            return b"".join(chunks), IOResult()
        dest = d if d else "/"
        writes: dict[str, bytes] = {}
        output_lines: list[str] = []
        for info in zf.infolist():
            if not info.is_dir():
                content = zf.read(info.filename)
                name = info.filename.split(
                    "/")[-1] if "/" in info.filename else info.filename
                out_path = dest.rstrip("/") + "/" + name
                await write_bytes(accessor, out_path, content)
                writes[out_path] = content
                if not q:
                    output_lines.append(f"  inflating: {out_path}")
    output = ("\n".join(output_lines) +
              "\n").encode() if output_lines else None
    return output, IOResult(writes=writes)
