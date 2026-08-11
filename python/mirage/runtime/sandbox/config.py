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

from mirage.runtime.config import RuntimeConfig


@dataclass(frozen=True, slots=True)
class SandboxConfig(RuntimeConfig):
    """How the sandbox machine is built: the fields every provider has.

    This base carries only what all providers support; each provider
    extends it with its own fields (DockerConfig, DaytonaConfig,
    E2BConfig), so an option a provider cannot honor is simply not a
    field there and fails loud at construction (RuntimeConfig.coerce).
    In yaml this is the runtime entry's ``config`` block, mirroring a
    mount's.

    Args:
        env (dict[str, str]): environment set in the sandbox.
    """

    env: dict[str, str] = field(default_factory=dict)
