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
    command to refuse by its number. The list is read in one pass,
    holding each name once and no more of the listing than one name.

    Args:
        source (PathSpec): the list, ``-`` for stdin when ``stream`` reads
            it from there.
        stream (Callable[[PathSpec], AsyncIterator[bytes]]): the reader;
            what it raises propagates.
    """
    names: list[str] = []
    held = bytearray()
    async for chunk in stream(source):
        start = 0
        while (at := chunk.find(b"\0", start)) != -1:
            held += chunk[start:at]
            names.append(decode_text(bytes(held)))
            held.clear()
            start = at + 1
        held += chunk[start:]
    if held:
        names.append(decode_text(bytes(held)))
    return names


__all__ = ["listed_names"]
