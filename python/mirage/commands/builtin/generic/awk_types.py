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

from mirage.types import PathSpec


class AwkCmpOp(StrEnum):
    EQ = "=="
    NE = "!="
    GT = ">"
    LT = "<"
    GE = ">="
    LE = "<="


class AwkBoolOp(StrEnum):
    AND = "&&"
    OR = "||"


class AwkBlock(StrEnum):
    BEGIN = "BEGIN"
    END = "END"


class AwkBuiltin(StrEnum):
    NR = "NR"
    NF = "NF"
    REC = "$0"


FIELD_PREFIX = "$"
PRINT_STMT = "print"

CMP_OP_PATTERN = r"==|!=|>=|<=|>|<"

USAGE = "awk: usage: awk [-F fs] [-v var=val] 'program' [file ...]"


@dataclass(frozen=True, slots=True)
class AwkFlags:
    field_separator: str | None
    assignments: tuple[str, ...]
    program_files: tuple[PathSpec, ...]


__all__ = [
    "AwkBlock",
    "AwkFlags",
    "AwkBoolOp",
    "AwkBuiltin",
    "AwkCmpOp",
    "CMP_OP_PATTERN",
    "FIELD_PREFIX",
    "PRINT_STMT",
    "USAGE",
]
