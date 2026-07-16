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

from mirage.workspace.store.base import WorkspaceFields, WorkspaceStateStore
from mirage.workspace.store.ram import RAMWorkspaceStateStore

__all__ = [
    "RAMWorkspaceStateStore",
    "RedisWorkspaceStateStore",
    "WorkspaceFields",
    "WorkspaceStateStore",
]


def __getattr__(name: str):
    if name == "RedisWorkspaceStateStore":
        from mirage.workspace.store.redis import RedisWorkspaceStateStore
        return RedisWorkspaceStateStore
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
