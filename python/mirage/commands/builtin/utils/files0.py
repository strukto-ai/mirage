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

from collections.abc import AsyncIterator, Callable

from mirage.shell.bytes import decode_text
from mirage.types import PathSpec


async def listed_names(
    source: PathSpec, stream: Callable[[PathSpec], AsyncIterator[bytes]]
) -> list[str]:
    """The names a ``--files0-from`` list holds: NUL-terminated, the last
    one with or without its NUL. An empty name stays in place, for the
    command to refuse by its number.

    Args:
        source (PathSpec): the list, ``-`` for stdin when ``stream`` reads
            it from there.
        stream (Callable[[PathSpec], AsyncIterator[bytes]]): the reader;
            what it raises propagates.
    """
    listing = b"".join([chunk async for chunk in stream(source)])
    names = listing.split(b"\0")
    if names[-1] == b"":
        names.pop()
    return [decode_text(name) for name in names]


__all__ = ["listed_names"]
