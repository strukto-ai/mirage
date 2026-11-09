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
from typing import Literal


@dataclass(frozen=True, slots=True)
class RepoEditField:
    """A repository setting's CLI grammar and API destination.

    Args:
        flag (str): Long option spelling.
        field (str): API field name.
        kind (Literal["value", "toggle", "security"]): Value encoding.
        description (str): Help text.
        short (str | None): Optional short spelling.
        metavar (str | None): The value's name in the usage block.
        choices (tuple[str, ...]): Allowed explicit values.
    """

    flag: str
    field: str
    kind: Literal["value", "toggle", "security"]
    description: str
    short: str | None = None
    choices: tuple[str, ...] = ()
    metavar: str | None = None
