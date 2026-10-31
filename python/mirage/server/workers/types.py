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
from enum import StrEnum


class WorkerType(StrEnum):
    """What a worker is: a process of its own, or a thread of the
    daemon's."""

    PROCESS = "process"
    THREAD = "thread"


@dataclass
class Answer:
    """What a worker answered, whole."""

    status: int
    headers: list[tuple[str, str]]
    body: bytes


@dataclass
class Peeked:
    """A request's body as far as it was read.

    Attributes:
        head (bytes): what was read, sent on first.
        more (bool): whether more of the body follows.
        id (str | None): the workspace id the body names, if it names one.
        lost (bool): whether the body passed ``MAX_REQUEST_PART`` before
            naming its id.
        twice (bool): whether a multipart load's ``request`` part comes
            twice in a row.
    """

    head: bytes
    more: bool
    id: str | None
    lost: bool = False
    twice: bool = False
