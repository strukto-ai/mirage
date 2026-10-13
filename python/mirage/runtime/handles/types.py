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

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

FlushKind = Literal["write", "append", "pwrite", "truncate"]

FileFetch = Callable[[int, int | None], bytes]


@dataclass(frozen=True, slots=True)
class FlushStep:
    """One op a closing handle owes the mount."""

    kind: FlushKind
    data: bytes = b""
    offset: int = 0
    length: int = 0


@dataclass(slots=True)
class Kept:
    """What a file still holds once its name was removed or replaced,
    shared by every handle open on it, as POSIX keeps one inode for them.

    Args:
        data (bytes): the stored bytes, with what its handles landed since.
        rendering (bytes | None): what a handle that only reads sees, when
            the mount renders the file other than it stores it; None when
            the two agree, so a reader reads ``data`` and every write
            landed on it.
        error (OSError | None): why the stored bytes could not be read
            before the name went, which every later read of them reports.
        rendering_error (OSError | None): why the rendering could not be
            read, which only a handle that reads it reports.
    """

    data: bytes = b""
    rendering: bytes | None = None
    error: OSError | None = None
    rendering_error: OSError | None = None
