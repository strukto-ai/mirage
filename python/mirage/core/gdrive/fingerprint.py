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

from mirage.types import JsonValue


def drive_fingerprint(md5: JsonValue, head_revision: JsonValue,
                      modified: JsonValue) -> str | None:
    """The one content token a Drive item is named by, read or stat.

    ``READ_REVALIDATABLE`` claims that ``io.stat`` and the read record
    stamp the *same kind* of token, and the way to make that structural
    rather than coincidental is to compute it in one place from one
    ordered chain that both sides call:

        md5Checksum -> headRevisionId -> modifiedTime -> None

    ``md5Checksum`` is the real content hash and is present on every
    ordinary binary file. ``headRevisionId`` is a second content token
    that Drive populates only for files with binary content, so it
    covers the binary file whose md5 Drive withholds -- it is not the
    native files' token, which is the thing it is easiest to assume.

    ``modifiedTime`` is the floor, and for a gdoc, gsheet or gslide it
    is the only token that exists at all: Drive gives a native file
    neither of the first two. Ending the chain one step earlier would
    hand every native file ``None``, which makes the freshness probe
    answer UNKNOWN and clear the whole mount index on every native read.
    It is a weaker token -- a rename moves it and provokes a refetch --
    but it errs toward refetching, never toward serving stale bytes.

    An empty string is absent, not a value: ``IndexEntry.remote_time``
    defaults to ``""`` and ``stat_from_api`` reads
    ``item.get("modifiedTime", "")``. Returned, it would escape the
    ``fingerprint is None`` checks in the reconcile probe and the drift
    check. The guard below tests emptiness explicitly so the TypeScript
    twin, whose ``??`` would keep ``""``, has something to mirror.

    Each candidate is type-checked rather than merely tested for
    truthiness: ``IndexEntry.extra`` is untyped and a Redis-restored
    index can hold whatever was serialized into it. Without the check
    this would return an int and ``==``-compare it against stat's
    string, while the TypeScript twin's ``typeof`` guard answered null.

    Args:
        md5 (JsonValue): Drive's ``md5Checksum``, if the item has one.
        head_revision (JsonValue): Drive's ``headRevisionId``, if any.
        modified (JsonValue): Drive's ``modifiedTime``.

    Returns:
        str | None: the first usable token, or None when the item
        carries none and the copy is therefore unverifiable.
    """
    for candidate in (md5, head_revision, modified):
        if isinstance(candidate, str) and candidate:
            return candidate
    return None
