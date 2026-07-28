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
class E2BConfig(SandboxConfig):
    """The E2B machine config, mapped onto AsyncSandbox.create.

    Images and sizing are deliberately not fields: E2B bakes both
    into a named template (`e2b template build`).

    Args:
        template (str | None): name or id of the template to boot
            (E2B's default template when omitted).
        params (dict[str, Any]): any other AsyncSandbox create kwarg
            passed verbatim (timeout, metadata, allow_internet_access,
            ...), merged last so it can override anything computed
            from the fields above.
    """

    template: str | None = None
    params: dict[str, Any] = field(default_factory=dict)
