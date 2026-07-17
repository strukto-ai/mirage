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
import uuid6


def uuid7() -> str:
    """Mint an RFC 9562 UUIDv7 in canonical lowercase hyphenated form.

    The first 48 bits are a unix-millisecond timestamp, so ids sort by
    creation time and stay index-friendly as database primary keys; the
    remaining 74 bits are random. Delegates to the ``uuid6`` package
    until ``uuid.uuid7`` lands in the stdlib (Python 3.14).

    Returns:
        str: canonical UUID string, e.g.
            ``0198c0de-6f3a-7d21-9c4e-8b1f2a3c4d5e``.
    """
    return str(uuid6.uuid7())


def new_workspace_id() -> str:
    """Mint a fresh workspace id (UUIDv7).

    Returns:
        str: time-ordered, collision-resistant workspace id.
    """
    return uuid7()


def new_session_id() -> str:
    """Mint a fresh session id (UUIDv7).

    Returns:
        str: time-ordered, collision-resistant session id.
    """
    return uuid7()
