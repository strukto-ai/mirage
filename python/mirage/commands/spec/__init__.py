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

from mirage.commands.spec.builtin_specs import SPECS
from mirage.commands.spec.constants import AMBIGUOUS_NAMES, flag_kwarg_name
from mirage.commands.spec.parser import parse_command, parse_to_kwargs
from mirage.commands.spec.types import (CommandSpec, FlagView, Operand,
                                        OperandKind, Option, ParsedArgs)

__all__ = [
    "AMBIGUOUS_NAMES",
    "CommandSpec",
    "Operand",
    "OperandKind",
    "Option",
    "ParsedArgs",
    "SPECS",
    "FlagView",
    "flag_kwarg_name",
    "parse_command",
    "parse_to_kwargs",
]
