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

import importlib
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mirage.workspace.executor.builtins.alias.alias import (
        alias_command_text,
        alias_mark,
        alias_value,
        alias_view,
        expanding_aliases,
        handle_alias,
        handle_unalias,
        note_expanding,
    )
    from mirage.workspace.executor.builtins.alias.types import AliasMark

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.workspace.executor.builtins.alias.alias": (
        "alias_command_text",
        "alias_mark",
        "alias_value",
        "alias_view",
        "expanding_aliases",
        "handle_alias",
        "handle_unalias",
        "note_expanding",
    ),
    "mirage.workspace.executor.builtins.alias.types": ("AliasMark",),
}
_MODULE_OF = {
    name: module for module, names in _EXPORTS.items() for name in names
}

__all__ = [
    "AliasMark",
    "alias_command_text",
    "alias_mark",
    "alias_value",
    "alias_view",
    "expanding_aliases",
    "handle_alias",
    "handle_unalias",
    "note_expanding",
]


def __getattr__(name: str) -> Any:
    module = _MODULE_OF.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(module), name)
    globals()[name] = value
    return value
