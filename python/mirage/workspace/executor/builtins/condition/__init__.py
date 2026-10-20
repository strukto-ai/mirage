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
    from mirage.workspace.executor.builtins.condition.condition import (
        handle_test,
    )
    from mirage.workspace.executor.builtins.condition.flat import eval_flat
    from mirage.workspace.executor.builtins.condition.tree import eval_cond
    from mirage.workspace.executor.builtins.condition.types import (
        CondAnd,
        CondBinary,
        CondContext,
        CondError,
        CondNode,
        CondNot,
        CondOr,
        CondUnary,
        CondWord,
    )

# Loaded on first use, as the builtins package loads its own: the gate
# reads test's operands (``operands``) from below the evaluator, which
# reaches back into the expansion that reads them.
_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.workspace.executor.builtins.condition.condition": ("handle_test",),
    "mirage.workspace.executor.builtins.condition.flat": ("eval_flat",),
    "mirage.workspace.executor.builtins.condition.tree": ("eval_cond",),
    "mirage.workspace.executor.builtins.condition.types": (
        "CondAnd",
        "CondBinary",
        "CondContext",
        "CondError",
        "CondNode",
        "CondNot",
        "CondOr",
        "CondUnary",
        "CondWord",
    ),
}

_MODULE_OF = {
    name: module for module, names in _EXPORTS.items() for name in names
}

__all__ = [
    "CondAnd",
    "CondBinary",
    "CondContext",
    "CondError",
    "CondNode",
    "CondNot",
    "CondOr",
    "CondUnary",
    "CondWord",
    "eval_cond",
    "eval_flat",
    "handle_test",
]


def __getattr__(name: str) -> Any:
    module = _MODULE_OF.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(module), name)
    globals()[name] = value
    return value
