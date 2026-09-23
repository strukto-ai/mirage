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

from dataclasses import dataclass, field
from typing import TypeAlias

from mirage.types import Limit, MountBackend, MountMode, ReadSpec
from mirage.vfs.base import BaseVFS
from mirage.workspace.mount.spec import Mount

VFSMount: TypeAlias = (BaseVFS | Mount
                       | tuple[BaseVFS, MountMode]
                       | tuple[BaseVFS, MountMode, dict[str, Limit]])


@dataclass(frozen=True, slots=True)
class MountSpec:
    """One entry of the ``mounts`` mapping, in resolved form.

    Every accepted spelling (bare VFS, ``(VFS, mode)`` tuple,
    full ``Mount``) narrows to this before the registry sees it, so the
    mount loop reads one shape instead of a union.
    """

    prefix: str
    vfs: BaseVFS
    mode: MountMode
    read: ReadSpec
    backend: MountBackend = MountBackend.WORKSPACE
    mountpoint: str | None = None
    command_limits: dict[str, Limit] = field(default_factory=dict)
