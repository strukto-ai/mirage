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

from dataclasses import dataclass

from mirage.runtime.sandbox.config import (
    SandboxConfig,
    check_mount_type,
    require_id,
)
from mirage.runtime.types import MountType


@dataclass(frozen=True, slots=True, kw_only=True)
class MicrosandboxConfig(SandboxConfig):
    """How to reach the user's running microVM.

    Args:
        sandbox (str): name of a running sandbox created and started
            by the user. Serve the workspace inside the guest at the
            same mount paths as the host.
        mount_type (MountType | None): ``ssh`` serves the host workspace
            over SFTP to guest sshfs, ``fuse`` uses the guest's own
            Mirage mounts, and ``both`` serves prefixes the guest does
            not mount itself. None leaves file setup to the user.
    """

    sandbox: str
    mount_type: MountType | None = None

    def __post_init__(self) -> None:
        require_id("microsandbox", "sandbox", self.sandbox)
        check_mount_type("microsandbox", self.mount_type)
