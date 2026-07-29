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

from dataclasses import dataclass, field, fields
from typing import Any, TypeVar

T = TypeVar("T", bound="SandboxConfig")


@dataclass(frozen=True, slots=True)
class SandboxConfig:
    """How the sandbox machine is built: the fields every provider has.

    This base carries only what all providers support; each provider
    extends it with its own fields (DockerConfig, DaytonaConfig,
    E2BConfig), so an option a provider cannot honor is simply not a
    field there and fails loud at construction. In yaml this is the
    runtime entry's ``config`` block, mirroring a mount's.

    Args:
        env (dict[str, str]): environment set in the sandbox.
    """

    env: dict[str, str] = field(default_factory=dict)

    @classmethod
    def coerce(cls: type[T],
               value: "SandboxConfig | dict[str, Any] | None") -> T:
        """A constructor's config argument as this provider's config.

        Args:
            value (SandboxConfig | dict | None): an instance, its
                dict form (a yaml ``config`` block), or None for the
                defaults. Unknown keys fail loud.
        """
        if value is None:
            return cls()
        if isinstance(value, cls):
            return value
        if isinstance(value, SandboxConfig):
            value = {f.name: getattr(value, f.name) for f in fields(value)}
        return cls(**value)
