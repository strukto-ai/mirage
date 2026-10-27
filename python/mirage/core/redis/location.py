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

from urllib.parse import parse_qs, urlsplit

from mirage.vfs.redis.constants import DEFAULT_PORT, LOOPBACK


def server_location(url: str) -> str:
    """Name the Redis server and database a URL reaches, one way.

    Two mounts of one keyspace must compare equal however their URLs are
    spelled, or a move between them copies a key onto itself and then
    deletes it. The scheme and credentials are dropped, a missing port or
    db takes redis-py's default, and a ``?db=`` query wins over the path
    as it does in redis-py.

    shortcut: only the loopback names are folded; a DNS name and its IP
    still read as two servers. Resolve them if two such mounts appear.

    Args:
        url (str): the Redis URL a mount was configured with.
    """
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    if parts.scheme == "unix":
        return f"unix:{parts.path}/{query.get('db', ['0'])[0]}"
    db = query.get("db", [parts.path.strip("/") or "0"])[0]
    # The scheme is ignored on purpose: one host and port is one store.
    host = (parts.hostname or "localhost").lower()
    if host in LOOPBACK:
        host = "localhost"
    return f"{host}:{parts.port or DEFAULT_PORT}/{db}"
