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

from mirage.runtime.sandbox.config import SandboxConfig, nonblank


@dataclass(frozen=True, slots=True, kw_only=True)
class AppleContainerConfig(SandboxConfig):
    """How to reach the user's running containers.

    Args:
        container (str | None): id of the running container for a
            session with none of its own in ``containers``.
        containers (dict[str, str]): session id to container id, one
            container per agent.
    """

    container: str | None = None
    containers: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.container is None and not self.containers:
            raise ValueError(
                "apple_container config needs container or containers"
            )
        if self.container is not None and not nonblank(self.container):
            raise ValueError("apple_container container must be a nonblank id")
        blank = sorted(
            session
            for session, container in self.containers.items()
            if not nonblank(container)
        )
        if blank:
            raise ValueError(
                "apple_container containers must map each "
                "session to a nonblank id: " + ", ".join(blank)
            )
        if self.mount_type is not None and self.containers:
            raise ValueError(
                "apple_container mount_type serves one session, "
                "so it cannot be combined with containers"
            )
