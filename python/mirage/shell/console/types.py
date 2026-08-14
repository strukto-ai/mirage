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
from enum import Enum


class Channel(str, Enum):
    STDOUT = "stdout"
    STDERR = "stderr"
    CONTROL = "control"


@dataclass(frozen=True, slots=True)
class ConsoleChunk:
    """One piece of a job's output, at a fixed position in its console.

    Chunks never change once appended, which is what lets a reader on any
    thread see either nothing or a whole chunk, never a torn one.

    Args:
        seq (int): position in the console, assigned by the store. Readers
            use it as their cursor.
        ts (float): epoch seconds when the chunk was appended.
        channel (Channel): which stream the bytes came from, or CONTROL for
            the terminating chunk.
        data (bytes): the payload. For a CONTROL chunk this is the outcome
            text, ``exit:<code>`` or ``killed``.
    """

    seq: int
    ts: float
    channel: Channel
    data: bytes


# Chunks read, the cursor to pass next time, and whether retention
# dropped the requested one.
ReadResult = tuple[list[ConsoleChunk], int, bool]
