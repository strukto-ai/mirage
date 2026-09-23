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

from mirage.types import Limit, MountBackend, MountMode, ReadSpec
from mirage.vfs.base import BaseVFS


@dataclass(frozen=True)
class Mount:
    vfs: BaseVFS
    mode: MountMode | None = None
    # How the mount is exposed. WORKSPACE (the default) keeps it inside
    # mirage's own filesystem; FUSE and FSKIT also register a real mountpoint.
    backend: MountBackend = MountBackend.WORKSPACE
    # Where to mount, for the kernel backends. None picks a temporary
    # directory appropriate for the backend. Ignored when backend is VFS.
    mountpoint: str | None = None
    command_limits: dict[str, Limit] = field(default_factory=dict)
    # How cached bytes for this mount are revalidated. None takes the
    # workspace default, as ``mode`` does.
    read: ReadSpec | None = None
