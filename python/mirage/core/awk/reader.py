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

from mirage.core.awk.builtins import take_record
from mirage.io.cooperative import chunks
from mirage.io.yield_budget import YieldBudget
from mirage.shell.bytes import byte_view


class RecordReader:
    """Cut one input stream into records with the RS in force at each read.

    RS is read again before every record, so an action that assigns it
    changes how the next record is cut, as in every awk. The stream is
    pulled only as far as the next record needs, so a reader that is
    closed early leaves the rest of a shared input unread.

    Args:
        source (bytes | AsyncIterator[bytes]): the input bytes.
        separator (Callable[[], str]): reads the current RS.
    """

    def __init__(
        self,
        source: bytes | AsyncIterator[bytes],
        separator: Callable[[], str],
    ) -> None:
        self.pulled = chunks(source)
        self.separator = separator
        self.budget = YieldBudget()
        self.buffer = ""
        self.start = 0
        self.final = False

    async def next(self) -> str | None:
        """Read the next record, or None once the input is exhausted."""
        while True:
            await self.budget.run()
            record, self.start = take_record(
                self.buffer, self.start, self.separator(), self.final
            )
            if record is not None:
                return record
            if self.final:
                return None
            data = await anext(self.pulled, None)
            self.final = data is None
            self.buffer = self.buffer[self.start :] + byte_view(data or b"")
            self.start = 0

    async def close(self) -> None:
        """Stop reading, releasing the stream."""
        await self.pulled.aclose()


__all__ = ["RecordReader"]
