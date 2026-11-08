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
    from mirage.machine.config import MachineConfig
    from mirage.machine.handle import MachineHandle

# Providers are not re-exported here: the machine registry reaches them
# by module path, so none loads until a machine is built. Import a
# provider from its own package.
_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.machine.config": ("MachineConfig",),
    "mirage.machine.handle": ("MachineHandle",),
}

__all__ = ["MachineConfig", "MachineHandle"]

__getattr__ = lazy_exports(__name__, _EXPORTS)
