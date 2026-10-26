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
    from mirage.policy.builtin.mount_root import MountRootPolicy
    from mirage.policy.builtin.output_cap import (
        ALL_COMMANDS,
        DEFAULT_COMMAND_LIMITS,
        resolve_limit,
        resolve_producer,
    )
    from mirage.policy.builtin.permissions import PermissionsPolicy
    from mirage.policy.builtin.placement import PlacementPolicy

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.policy.builtin.mount_root": ("MountRootPolicy",),
    "mirage.policy.builtin.output_cap": (
        "ALL_COMMANDS",
        "DEFAULT_COMMAND_LIMITS",
        "resolve_limit",
        "resolve_producer",
    ),
    "mirage.policy.builtin.permissions": ("PermissionsPolicy",),
    "mirage.policy.builtin.placement": ("PlacementPolicy",),
}

__all__ = [
    "ALL_COMMANDS",
    "DEFAULT_COMMAND_LIMITS",
    "MountRootPolicy",
    "PermissionsPolicy",
    "PlacementPolicy",
    "resolve_producer",
    "resolve_limit",
]

__getattr__ = lazy_exports(__name__, _EXPORTS)
