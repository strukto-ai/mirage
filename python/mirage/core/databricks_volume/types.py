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

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class DatabricksEntry:
    """One row of a ``GET /api/2.0/fs/directories`` listing.

    ``last_modified`` is epoch milliseconds as the listing sends it; a
    HEAD-derived entry carries the HTTP date string instead, which is
    why both spellings are allowed here rather than normalized at the
    wire.
    """

    path: str
    is_directory: bool
    file_size: int | None
    last_modified: int | str | None


@dataclass(frozen=True, slots=True)
class DatabricksFileMeta:
    """The headers a ``HEAD /api/2.0/fs/files`` answer carries."""

    content_length: int | None
    content_type: str | None
    last_modified: str | None
