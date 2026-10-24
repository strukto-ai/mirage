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
    from mirage.runtime.routing.decide import runtime_for_language
    from mirage.runtime.routing.errors import RouteError
    from mirage.runtime.routing.types import RouteDecision, RoutePolicy

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.runtime.routing.decide": ("runtime_for_language",),
    "mirage.runtime.routing.errors": ("RouteError",),
    "mirage.runtime.routing.types": ("RouteDecision", "RoutePolicy"),
}

__all__ = [
    "RouteDecision",
    "RoutePolicy",
    "RouteError",
    "runtime_for_language",
]

__getattr__ = lazy_exports(__name__, _EXPORTS)
