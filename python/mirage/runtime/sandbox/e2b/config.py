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
class E2BConfig(SandboxConfig):
    """How to reach the user's live E2B sandbox.

    Args:
        sandbox_id (str): id of a sandbox you created (`e2b sandbox
            spawn` or the SDK), with workspace files visible at matching
            paths when commands need them.
        api_key (str | None): E2B credential; None reads E2B_API_KEY.
        mount_type (MountType | None): how the sandbox sees the
            workspace: ``ssh`` serves every prefix the session sees from
            the host over SFTP (the image needs sshfs), ``fuse`` leaves
            them to a mirage in the sandbox, ``both`` serves from the
            host what the sandbox does not mount itself. None serves
            nothing.
    """

    sandbox_id: str
    api_key: str | None = None
    mount_type: MountType | None = None

    def __post_init__(self) -> None:
        require_id("e2b", "sandbox_id", self.sandbox_id)
        check_mount_type("e2b", self.mount_type)
