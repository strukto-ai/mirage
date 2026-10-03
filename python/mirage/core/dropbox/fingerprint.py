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

import json
import logging

from mirage.cache.index import IndexEntry
from mirage.core.dropbox.constants import CONTENT_HASH, RESULT_HEADER
from mirage.types import JsonValue

logger = logging.getLogger(__name__)


def token_of(value: JsonValue) -> str | None:
    """A file's content token: its content_hash, or None.

    The one rule stat, readdir and read all stamp by, so the two sides of a
    `read: fresh` check are always the same kind. server_modified is no
    content token: the real service repeats it across same-size rewrites.

    Args:
        value (JsonValue): a ``content_hash`` field as the API sent it.
    """
    return value if isinstance(value, str) and value else None


def entry_token(entry: IndexEntry) -> str | None:
    """The content token a listing row carries.

    Args:
        entry (IndexEntry): the file's index row.
    """
    return token_of(entry.extra.get(CONTENT_HASH))


def result_token(raw: str | None) -> str | None:
    """The content token a download's ``Dropbox-API-Result`` names.

    The header carries the file's metadata on a full and on a ranged (206)
    download alike, so a read stamps the token stat answers with no
    request of its own. A missing or unreadable header is no token; an
    unreadable one warns, since Dropbox always sends JSON there and every
    fresh read of the file then goes cold.

    Args:
        raw (str | None): the header's value, or None when absent.
    """
    if not raw:
        return None
    try:
        result = json.loads(raw)
    except ValueError as exc:
        logger.warning("unreadable %s header: %s", RESULT_HEADER, exc)
        return None
    if not isinstance(result, dict):
        return None
    return token_of(result.get(CONTENT_HASH))
