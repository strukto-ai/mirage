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
    from mirage.workspace.executor.builtins.resources.free import handle_free
    from mirage.workspace.executor.builtins.resources.hostname import (
        handle_hostname,
    )
    from mirage.workspace.executor.builtins.resources.lscpu import handle_lscpu
    from mirage.workspace.executor.builtins.resources.nproc import handle_nproc
    from mirage.workspace.executor.builtins.resources.top import handle_top
    from mirage.workspace.executor.builtins.resources.uptime import (
        handle_uptime,
    )

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.workspace.executor.builtins.resources.free": ("handle_free",),
    "mirage.workspace.executor.builtins.resources.hostname": (
        "handle_hostname",
    ),
    "mirage.workspace.executor.builtins.resources.lscpu": ("handle_lscpu",),
    "mirage.workspace.executor.builtins.resources.nproc": ("handle_nproc",),
    "mirage.workspace.executor.builtins.resources.top": ("handle_top",),
    "mirage.workspace.executor.builtins.resources.uptime": ("handle_uptime",),
}

__all__ = [
    "handle_free",
    "handle_hostname",
    "handle_lscpu",
    "handle_nproc",
    "handle_top",
    "handle_uptime",
]

__getattr__ = lazy_exports(__name__, _EXPORTS)
