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
    from mirage.commands.builtin.generic.crossmount.detect import (
        is_cross_mount as is_cross_mount,
    )
    from mirage.commands.builtin.generic.crossmount.route import (
        handle_cross_mount as handle_cross_mount,
    )

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.commands.builtin.generic.crossmount.detect": ("is_cross_mount",),
    "mirage.commands.builtin.generic.crossmount.route": (
        "handle_cross_mount",
    ),
}
__all__ = ["is_cross_mount", "handle_cross_mount"]

__getattr__ = lazy_exports(__name__, _EXPORTS)
