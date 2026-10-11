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

from mirage.runtime.sandbox.config import SandboxConfig, check_mount_type
from mirage.runtime.types import MountType


@dataclass(frozen=True, slots=True, kw_only=True)
class DockerConfig(SandboxConfig):
    """How to reach the user's running container.

    Args:
        container (str): id or name of a running container. You start
            it yourself (`docker run -d ... sleep infinity`); live
            FUSE mounts need `--cap-add SYS_ADMIN --device /dev/fuse`
            and an image with mirage installed.
        mount_type (MountType | None): how the sandbox sees the
            workspace: ``ssh`` serves every prefix the session sees from
            the host over SFTP (the image needs sshfs), ``fuse`` leaves
            them to a mirage in the sandbox, ``both`` serves from the
            host what the sandbox does not mount itself. None serves
            nothing.
    """

    container: str
    mount_type: MountType | None = None

    def __post_init__(self) -> None:
        check_mount_type("docker", self.mount_type)
