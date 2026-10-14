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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.gdrive import NATIVE_RESOURCE_TYPES
from mirage.core.gdrive.fingerprint import drive_fingerprint
from mirage.core.gdrive.read import file_entry
from mirage.core.google.client import drive_base, google_get
from mirage.observe.context import record, revision_for, start_op
from mirage.types import PathSpec

# The digests Drive keeps for a file's content, by hashlib name.
DIGEST_FIELDS = {
    "md5": "md5Checksum",
    "sha1": "sha1Checksum",
    "sha256": "sha256Checksum",
}


async def checksum(
    accessor: GDriveAccessor,
    path: PathSpec,
    algorithm: str,
    index: IndexCacheStore = NULL_INDEX,
) -> str | None:
    """The digest Drive keeps for a file's content.

    Drive hashes the bytes of every file it stores, which are the bytes
    a read downloads. A Google Docs, Sheets or Slides file has no stored
    bytes, only a rendering, and a pinned revision reads older bytes
    than the file's own digest names, so both are read instead. A digest
    answered is recorded as the read it stands in for, with the token
    and head revision a read would record, so a snapshot pins them and
    a conditional write later in the line is conditioned on them.

    Args:
        accessor (GDriveAccessor): Drive accessor.
        path (PathSpec): the file.
        algorithm (str): the hashlib name asked for.
        index (IndexCacheStore): listing cache, consulted for the file id.
    """
    field = DIGEST_FIELDS.get(algorithm)
    if field is None or revision_for(path.virtual) is not None:
        return None
    entry = await file_entry(accessor, path, index)
    if entry.resource_type in NATIVE_RESOURCE_TYPES:
        return None
    token_manager = accessor.token_manager
    timer = start_op()
    fields = dict.fromkeys([field, "md5Checksum", "headRevisionId"])
    item = await google_get(
        token_manager,
        f"{drive_base(token_manager)}/files/{entry.id}",
        params={"fields": ",".join(fields), "supportsAllDrives": "true"},
    )
    found = item.get(field)
    if not isinstance(found, str) or not found:
        return None
    revision = item.get("headRevisionId")
    record(
        "read",
        path.virtual,
        "gdrive",
        0,
        timer,
        fingerprint=drive_fingerprint(
            entry.resource_type,
            item.get("md5Checksum"),
            revision,
            entry.remote_time,
        ),
        revision=revision if isinstance(revision, str) else None,
    )
    return found.lower()
