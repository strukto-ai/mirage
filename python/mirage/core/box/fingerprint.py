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

from mirage.cache.index import IndexEntry
from mirage.core.box.constants import SHA1
from mirage.types import JsonValue


def token_of(value: JsonValue) -> str | None:
    """A file's content token: its sha1, or None.

    The one rule stat, readdir and read all stamp by, so the two sides of a
    `read: fresh` check are always the same kind. modified_at is no content
    token: two same-size edits in one second share it on the real service.

    Args:
        value (JsonValue): a ``sha1`` field as the API sent it.
    """
    return value if isinstance(value, str) and value else None


def entry_token(entry: IndexEntry) -> str | None:
    """The content token a listing row carries.

    Args:
        entry (IndexEntry): the file's index row.
    """
    return token_of(entry.extra.get(SHA1))


def read_token(entry: IndexEntry, digest: str) -> str | None:
    """The token a whole read stamps: the listed sha1, if the bytes match it.

    A download carries no version header, so the bytes are checked against
    the row they were resolved through. A writer between the listing and
    the download leaves them disagreeing, and new bytes are never labelled
    with the old token.

    Args:
        entry (IndexEntry): the row the read resolved through.
        digest (str): SHA-1 hex of the bytes the read returned.
    """
    token = entry_token(entry)
    return token if token is not None and token == digest else None
