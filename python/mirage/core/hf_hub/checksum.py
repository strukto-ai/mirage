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

import re

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.core.hf_hub.lookup import refusals_denied
from mirage.core.hf_hub.read import resolve_entry, row_token
from mirage.core.hf_hub.tree import fetch_path
from mirage.observe.context import record, start_op
from mirage.types import FileStat, PathSpec

LFS_OID = re.compile(r"[0-9a-f]{64}")


async def checksum(
    accessor: HfHubAccessor,
    path: PathSpec,
    algorithm: str,
    entry: FileStat | None = None,
) -> str | None:
    """The sha256 the Hub keeps for an LFS file, asked live.

    An LFS file's row carries its LFS oid, the sha256 of exactly the
    bytes a read downloads. A plain git blob's oid hashes a git header
    with the bytes, and the Hub keeps no other digest, so every other
    file and algorithm is read, without a request when the listing's row
    names no LFS oid. The listing's row can be older than the bytes a read
    downloads, so an LFS file's row is asked again with one paths-info
    request, the row a tree walk carries. A digest answered is recorded as
    the read it stands in for, with the token a read of those bytes would
    record.

    Args:
        accessor (HfHubAccessor): backend handle.
        path (PathSpec): the file.
        algorithm (str): the hashlib name asked for.
        entry (FileStat | None): the file's row, which tells a file, a
            directory and an absence apart as the read does.
    """
    if algorithm != "sha256":
        return None
    listed = resolve_entry(path, entry)
    if not listed.extra.get("lfs_oid"):
        return None
    rel = path.mount_path.strip("/")
    timer = start_op()
    with refusals_denied(path):
        row = (await fetch_path(accessor, rel)).get(rel)
    if row is None or not LFS_OID.fullmatch(row.lfs_oid):
        return None
    record(
        "read",
        path.virtual,
        accessor.VFS_NAME,
        0,
        timer,
        fingerprint=row_token(listed, row.lfs_oid),
    )
    return row.lfs_oid
