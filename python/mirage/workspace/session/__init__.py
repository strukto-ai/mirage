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
    from mirage.context import (
        get_current_session,
        get_current_session_for,
        reset_current_session,
        set_current_session,
    )
    from mirage.workspace.session.errors import ReadonlyVariableError
    from mirage.workspace.session.manager import SessionManager
    from mirage.workspace.session.ram import RAMSessionStore
    from mirage.workspace.session.redis import RedisSessionStore
    from mirage.workspace.session.s3 import S3SessionStore
    from mirage.workspace.session.session import SessionState
    from mirage.workspace.session.state import (
        ensure_var_visible,
        env_snapshot,
        exported_names,
        session_view,
        visible_arrays,
        visible_env,
    )
    from mirage.workspace.session.store import (
        SessionFields,
        SessionStore,
    )

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.context": (
        "get_current_session",
        "get_current_session_for",
        "reset_current_session",
        "set_current_session",
    ),
    "mirage.workspace.session.errors": ("ReadonlyVariableError",),
    "mirage.workspace.session.manager": ("SessionManager",),
    "mirage.workspace.session.ram": ("RAMSessionStore",),
    "mirage.workspace.session.redis": ("RedisSessionStore",),
    "mirage.workspace.session.s3": ("S3SessionStore",),
    "mirage.workspace.session.session": ("SessionState",),
    "mirage.workspace.session.state": (
        "ensure_var_visible",
        "env_snapshot",
        "exported_names",
        "session_view",
        "visible_arrays",
        "visible_env",
    ),
    "mirage.workspace.session.store": (
        "SessionFields",
        "SessionStore",
    ),
}
_MODULE_OF = {
    name: module for module, names in _EXPORTS.items() for name in names
}

__all__ = [
    "RAMSessionStore",
    "ReadonlyVariableError",
    "RedisSessionStore",
    "S3SessionStore",
    "SessionFields",
    "SessionManager",
    "SessionState",
    "SessionStore",
    "ensure_var_visible",
    "env_snapshot",
    "exported_names",
    "get_current_session",
    "get_current_session_for",
    "reset_current_session",
    "session_view",
    "set_current_session",
    "visible_arrays",
    "visible_env",
]


def __getattr__(name: str) -> Any:
    module = _MODULE_OF.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(module), name)
    globals()[name] = value
    return value
