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

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.core.msgraph.events import DeltaTarget, GraphDeltaHook
from mirage.core.onedrive.client import drive_base
from mirage.events.base import DeltaHook
from mirage.events.payload import virtual_of
from mirage.types import PathSpec


def build_delta_hook(accessor: OneDriveAccessor) -> DeltaHook:
    """Build the OneDrive delta hook: the drive's ``/delta`` feed
    (``GraphDeltaHook``), placed under the mount's ``key_prefix``.

    Args:
        accessor (OneDriveAccessor): Backend handle.
    """
    config = accessor.config

    async def targets(root: PathSpec) -> list[DeltaTarget]:
        return [
            DeltaTarget(
                drive=drive_base(config),
                folder=config.key_prefix or "",
                virtual=virtual_of(root, ""),
            )
        ]

    return GraphDeltaHook(config, accessor.pool, targets)
