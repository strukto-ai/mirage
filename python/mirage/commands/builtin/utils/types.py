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

from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Callable

from mirage.types import FileStat

AsyncStatFn = Callable[[str], Awaitable[FileStat]]
AsyncReaddirFn = Callable[[str], Awaitable[list[str]]]


@dataclass(frozen=True, slots=True)
class HostRegex:
    """A pattern translated from its dialect into this host's.

    Args:
        source (str): the host source.
        ignore_case (bool): the host engine must fold case itself. A
            translator folds each literal and class in the source when
            case sensitivity changes inside the pattern, and leaves it to
            the host when the whole pattern is caseless, which keeps the
            source plain enough for the grep prefilter to read.
    """

    source: str
    ignore_case: bool = False
