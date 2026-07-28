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
from typing import Any

from mirage.runtime.sandbox.config import SandboxConfig


@dataclass(frozen=True, slots=True)
class DaytonaConfig(SandboxConfig):
    """The Daytona machine config, mapped onto the create params.

    Args:
        image (str | None): image built inline at create time.
            Mutually exclusive with template.
        template (str | None): name of a prebaked Daytona snapshot.
            Prefer it for anything heavy: an inline image build sits
            in the create path, a snapshot boots in seconds.
        cpu (int | None): CPU cores; sizing requires an image.
        memory (int | None): memory in GiB.
        disk (int | None): disk in GiB.
        gpu (int | str | None): GPU count or type spec; truthy forces
            the sandbox ephemeral, as Daytona requires.
        params (dict[str, Any]): any other Daytona create option
            passed verbatim (auto_stop_interval, labels, volumes,
            ...), merged last so it can override anything computed
            from the fields above.
    """

    image: str | None = None
    template: str | None = None
    cpu: int | None = None
    memory: int | None = None
    disk: int | None = None
    gpu: int | str | None = None
    params: dict[str, Any] = field(default_factory=dict)

    def sized(self) -> bool:
        """Whether any per-sandbox sizing field is set."""
        sizing = (self.cpu, self.memory, self.disk, self.gpu)
        return any(value is not None for value in sizing)
