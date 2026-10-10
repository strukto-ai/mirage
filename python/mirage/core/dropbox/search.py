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

import logging

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.api import search_files
from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


async def files_containing(
    accessor: DropboxAccessor, text: str, under: list[PathSpec]
) -> set[str] | None:
    """Mount keys of the files under ``under`` Dropbox search returns.

    Hits are kept inside each scope on ``path_lower`` (Dropbox paths are
    case-insensitive) and keyed from ``path_display``. None whenever the
    answer may miss a match: an API failure, the 10,000-match ceiling, or
    no hit at all, since Dropbox indexes a write some time after it lands.

    Args:
        accessor (DropboxAccessor): backend handle carrying the root path.
        text (str): the whole word searched for.
        under (list[PathSpec]): the directories walked.
    """
    root = accessor.root_path
    keys: set[str] = set()
    for p in under:
        scope_api = dropbox_path_of(accessor, p)
        try:
            results, truncated = await search_files(
                accessor.token_manager, text, path=scope_api
            )
        except DropboxApiError as exc:
            logger.warning(
                "dropbox search failed (%s); reading every file", exc
            )
            return None
        if truncated:
            return None
        scope_lower = scope_api.lower()
        scope_prefix = scope_lower.rstrip("/") + "/"
        for lower, display in results:
            if lower == scope_lower or lower.startswith(scope_prefix):
                key = display[len(root) :].strip("/")
                if key:
                    keys.add(key)
    return keys or None
