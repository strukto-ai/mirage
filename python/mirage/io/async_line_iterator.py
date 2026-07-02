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

from collections.abc import AsyncIterator


class AsyncLineIterator:

    def __init__(self, source: AsyncIterator[bytes]) -> None:
        self._source = source
        self._buf = b""
        self._exhausted = False

    def __aiter__(self) -> "AsyncLineIterator":
        return self

    async def __anext__(self) -> bytes:
        line = await self.readline()
        if line is None:
            raise StopAsyncIteration
        return line

    async def readline(self) -> bytes | None:
        """Return next line (without trailing newline), or None at EOF."""
        while b"\n" not in self._buf:
            if self._exhausted:
                if self._buf:
                    remaining = self._buf
                    self._buf = b""
                    return remaining
                return None
            try:
                chunk = await self._source.__anext__()
            except StopAsyncIteration:
                self._exhausted = True
                continue
            self._buf += chunk
        line, self._buf = self._buf.split(b"\n", 1)
        return line
