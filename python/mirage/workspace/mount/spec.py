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

from mirage.cache.index import IndexConfig
from mirage.types import Limit, MountBackend, MountMode, ReadSpec, WritePolicy
from mirage.vfs.base import BaseVFS


@dataclass(frozen=True)
class Mount:
    """A driver and its placement settings.

    ``backend`` exposes the mount inside the workspace or at a kernel
    ``mountpoint``. ``vfs_ref`` names its registry or code loader for
    snapshots. ``index``, ``read`` and ``write`` override the workspace
    defaults;
    without an index default, RAM uses the driver's ``index_ttl``.
    """

    vfs: BaseVFS
    mode: MountMode | None = None
    backend: MountBackend = MountBackend.WORKSPACE
    mountpoint: str | None = None
    command_limits: dict[str, Limit] = field(default_factory=dict)
    vfs_ref: str | None = None
    index: IndexConfig | None = None
    read: ReadSpec | None = None
    write: WritePolicy | str | None = None
