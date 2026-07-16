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

from mirage.context import (assert_mount_allowed, get_current_session,
                            reset_current_session, set_current_session)
from mirage.workspace.session.manager import SessionManager
from mirage.workspace.session.ram import RAMSessionStore
from mirage.workspace.session.session import Session
from mirage.workspace.session.store import SessionFields, SessionStore

__all__ = [
    "RAMSessionStore",
    "RedisSessionStore",
    "Session",
    "SessionFields",
    "SessionManager",
    "SessionStore",
    "assert_mount_allowed",
    "get_current_session",
    "reset_current_session",
    "set_current_session",
]


def __getattr__(name: str):
    if name == "RedisSessionStore":
        from mirage.workspace.session.redis import RedisSessionStore
        return RedisSessionStore
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
