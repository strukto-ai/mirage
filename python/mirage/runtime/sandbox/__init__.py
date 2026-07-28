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

import importlib
from typing import TYPE_CHECKING

from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.config import SandboxConfig

if TYPE_CHECKING:
    from mirage.runtime.sandbox.daytona import DaytonaRuntime
    from mirage.runtime.sandbox.docker import DockerRuntime
    from mirage.runtime.sandbox.e2b import E2BRuntime

# Provider modules import their (heavy, optional) SDKs at module load,
# so the package resolves them lazily: importing the base or a sibling
# provider must not pull every SDK in.
_PROVIDERS: dict[str, str] = {
    "DaytonaRuntime": "mirage.runtime.sandbox.daytona",
    "DockerRuntime": "mirage.runtime.sandbox.docker",
    "E2BRuntime": "mirage.runtime.sandbox.e2b",
}

__all__ = [
    "DaytonaRuntime", "DockerRuntime", "E2BRuntime", "RemoteSandbox",
    "SandboxConfig"
]


def __getattr__(name: str) -> type[RemoteSandbox]:
    module = _PROVIDERS.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    runtime: type[RemoteSandbox] = getattr(importlib.import_module(module),
                                           name)
    return runtime
