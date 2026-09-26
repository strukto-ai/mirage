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

from urllib.parse import quote

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.core.hf_hub.client import HfHubError, etag_value, hub_post
from mirage.types import JsonValue


def _base(accessor: HfBucketsAccessor) -> str:
    return accessor.endpoint.rstrip("/")


def paths_info_url(accessor: HfBucketsAccessor) -> str:
    """The paths-info endpoint of the mount's bucket.

    A bucket has no revisions, so unlike a repository's route this one
    carries no revision segment: ``/paths-info/main`` answers 404.

    Args:
        accessor (HfBucketsAccessor): the mount's accessor.

    Returns:
        str: the absolute URL.
    """
    return f"{_base(accessor)}/api/buckets/{accessor.config.bucket}/paths-info"


def resolve_url(accessor: HfBucketsAccessor, rel: str) -> str:
    """The content URL of one bucket file.

    The path is percent-encoded per segment, as a repository's resolve
    URL is: a name holding a "#" pasted raw truncates at the fragment.

    Args:
        accessor (HfBucketsAccessor): the mount's accessor.
        rel (str): the path as the mount sees it.

    Returns:
        str: the absolute URL, which answers a redirect to the CDN.
    """
    return (f"{_base(accessor)}/buckets/{accessor.config.bucket}/resolve/"
            f"{quote(accessor.bucket_path(rel))}")


async def fetch_row(accessor: HfBucketsAccessor,
                    key: str) -> dict[str, JsonValue] | None:
    """The paths-info row of one bucket file, in one request.

    paths-info answers a missing path, a directory and a leading-slash
    spelling alike with an empty list, and a file with its row, so only a
    file row naming exactly the asked path is an answer. A row for some
    other path is not evidence about this one, and must not read as its
    absence: reconcile deletes what it believes is gone.

    Args:
        accessor (HfBucketsAccessor): the mount's accessor.
        key (str): the path as the mount sees it; "" is the mount root,
            which is never a file.

    Returns:
        dict[str, JsonValue] | None: the file's row, or None when the
        path holds no file.

    Raises:
        HfHubError: the Hub refused, or answered about another path.
    """
    if not key.strip("/"):
        return None
    asked = accessor.bucket_path(key)
    rows = await hub_post(accessor.token,
                          paths_info_url(accessor), {"paths": [asked]},
                          session=accessor.pool)
    if not isinstance(rows, list):
        raise HfHubError(f"paths-info answered no list for {asked}", 0,
                         "InvalidResponse")
    matching = [
        row for row in rows
        if isinstance(row, dict) and row.get("path") == asked
    ]
    if rows and not matching:
        raise HfHubError(f"paths-info answered no row for {asked}", 0,
                         "PathMismatch")
    for row in matching:
        if row.get("type") == "file":
            return row
    return None


def read_token(raw_etag: str) -> str | None:
    """The content token a download's ETag vouches for, or None.

    A bucket file's strong ETag is its xet hash, the value paths-info
    reports, whether the read was whole or ranged. A weak validator
    promises equivalence rather than the same bytes, so it vouches for
    nothing, and neither does an empty one.

    Args:
        raw_etag (str): the final response's ETag header, "" when none.

    Returns:
        str | None: the token to stamp.
    """
    if raw_etag.strip().startswith("W/"):
        return None
    return etag_value(raw_etag) or None
