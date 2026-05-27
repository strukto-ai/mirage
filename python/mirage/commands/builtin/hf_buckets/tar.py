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
import tarfile
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


def _compression_suffix(z: bool, j: bool, J: bool) -> str:
    if z:
        return ":gz"
    if j:
        return ":bz2"
    if J:
        return ":xz"
    return ""


@command("tar", resource="hf_buckets", spec=SPECS["tar"], write=True)
async def tar(
    accessor: HfBucketsAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    c: bool = False,
    x: bool = False,
    t: bool = False,
    z: bool = False,
    j: bool = False,
    J: bool = False,
    v: bool = False,
    f: PathSpec | None = None,
    C: PathSpec | None = None,
    strip_components: str | None = None,
    exclude: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_glob(accessor, paths, index)
    archive_path = f.strip_prefix if f else None
    dest_path = C.strip_prefix if C else "/"
    mode_suffix = _compression_suffix(z, j, J)
    strip_n = int(strip_components) if strip_components else 0
    if c:
        if not archive_path:
            raise ValueError("tar: -f is required")
        filtered_paths = paths
        if exclude:
            filtered_paths = [
                p for p in paths if exclude not in p.original.split("/")[-1]
            ]
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode=f"w{mode_suffix}") as tf:
            for p in filtered_paths:
                data = await read_bytes(accessor, p)
                name = p.original.lstrip("/")
                info = tarfile.TarInfo(name=name)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
        archive = buf.getvalue()
        await write_bytes(accessor, archive_path, archive)
        return None, IOResult(writes={archive_path: archive})
    if t:
        if not archive_path:
            raise ValueError("tar: -f is required")
        data = await read_bytes(accessor, archive_path)
        with tarfile.open(fileobj=io.BytesIO(data),
                          mode=f"r{mode_suffix}") as tf:
            names = tf.getnames()
        return ("\n".join(names) + "\n").encode(), IOResult()
    if x:
        if not archive_path:
            raise ValueError("tar: -f is required")
        data = await read_bytes(accessor, archive_path)
        writes: dict[str, bytes] = {}
        with tarfile.open(fileobj=io.BytesIO(data),
                          mode=f"r{mode_suffix}") as tf:
            for member in tf.getmembers():
                if member.isfile():
                    extracted = tf.extractfile(member)
                    if extracted:
                        content = extracted.read()
                        name_parts = member.name.split("/")
                        if strip_n > 0:
                            name_parts = name_parts[strip_n:]
                        if not name_parts:
                            continue
                        out_path = dest_path.rstrip("/") + "/" + "/".join(
                            name_parts)
                        await write_bytes(accessor, out_path, content)
                        writes[out_path] = content
        return None, IOResult(writes=writes)
    raise ValueError("tar: must specify -c, -x, or -t")
