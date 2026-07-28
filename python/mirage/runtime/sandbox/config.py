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


@dataclass(frozen=True, slots=True)
class SandboxConfig:
    """How the sandbox machine is built: one shape for every provider.

    Each provider consumes the fields it can honor and rejects the
    rest loudly (e2b bakes image and sizing into the template; docker
    has no per-container disk limit). In yaml this is the runtime
    entry's ``config`` block, mirroring a mount's ``config`` block.

    Args:
        image (str | None): image to boot. docker: a local or registry
            image (python:3.12-slim when omitted); daytona: an inline
            image build at create time; e2b: rejected, templates only.
        template (str | None): prebuilt boot source: a Daytona
            snapshot or an e2b template name. Boots in seconds where
            an inline image builds in the create path.
        env (dict[str, str]): environment set in the sandbox.
        cpu (int | None): CPU cores.
        memory (int | None): memory in GiB.
        disk (int | None): disk in GiB.
        gpu (int | str | None): GPU count or type spec, for providers
            that take one.
        args (list[str]): CLI flags passed verbatim where the provider
            is CLI-driven (docker run flags: binds, --cap-add,
            --network, ...). SDK providers reject them.
        params (dict[str, Any]): provider create options passed
            verbatim to the SDK, merged last so they can override
            anything computed from the fields above (daytona:
            auto_stop_interval, labels, volumes, ...; e2b: timeout,
            metadata, ...). Unknown keys fail loud in the SDK's own
            validation.
    """

    image: str | None = None
    template: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    cpu: int | None = None
    memory: int | None = None
    disk: int | None = None
    gpu: int | str | None = None
    args: list[str] = field(default_factory=list)
    params: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def coerce(cls, value: "SandboxConfig | dict[str, Any] | None"
               ) -> "SandboxConfig":
        """A constructor's config argument as a SandboxConfig.

        Args:
            value (SandboxConfig | dict | None): an instance, its
                dict form (a yaml ``config`` block), or None for the
                defaults. Unknown dict keys fail loud.
        """
        if value is None:
            return cls()
        if isinstance(value, SandboxConfig):
            return value
        return cls(**value)

    def sized(self) -> bool:
        """Whether any per-sandbox sizing field is set."""
        sizing = (self.cpu, self.memory, self.disk, self.gpu)
        return any(value is not None for value in sizing)
