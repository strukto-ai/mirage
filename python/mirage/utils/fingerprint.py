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


def stat_fingerprint(etag: str | None, modified: str | None,
                     size: int | None) -> str:
    """Mirage's default content fingerprint from listing metadata.

    Prefers the backend's native version (ETag/rev), the same value
    backends put in ``FileStat.fingerprint``; falls back to a
    ``mtime|size`` composite, which every listing carries and which
    still flips on a content write. Distinct from
    ``mirage.cache.file.utils.default_fingerprint``, which hashes the
    content bytes themselves.

    Args:
        etag (str | None): Native version identifier, if any.
        modified (str | None): Last-modified stamp.
        size (int | None): Content size in bytes.
    """
    if etag:
        return etag
    return f"{modified or ''}|{size}"
