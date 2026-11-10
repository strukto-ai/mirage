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

from typing import TYPE_CHECKING

from mirage.utils.loader import lazy_exports

if TYPE_CHECKING:
    from mirage.workspace.executor.builtins.pgrep.killall import handle_killall
    from mirage.workspace.executor.builtins.pgrep.pgrep import (
        handle_pgrep,
        handle_pkill,
    )
    from mirage.workspace.executor.builtins.pgrep.pidof import handle_pidof

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.workspace.executor.builtins.pgrep.killall": ("handle_killall",),
    "mirage.workspace.executor.builtins.pgrep.pgrep": (
        "handle_pgrep",
        "handle_pkill",
    ),
    "mirage.workspace.executor.builtins.pgrep.pidof": ("handle_pidof",),
}

__all__ = [
    "handle_killall",
    "handle_pgrep",
    "handle_pidof",
    "handle_pkill",
]

__getattr__ = lazy_exports(__name__, _EXPORTS)
