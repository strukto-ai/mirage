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

from mirage.runtime.config import RuntimeConfig


@dataclass(frozen=True, slots=True)
class WasmFsConfig(RuntimeConfig):
    """What the filesystem a wasm guest sees is made of.

    Knobs only. The live wiring a guest also needs, its `RuntimeVFS`,
    is a constructor argument rather than a field here, because a
    dispatch coroutine and an event loop are not settings and do not
    belong in something a yaml block can name.

    `host_root` is a resolved directory, not the `home` a runtime's own
    config carries: the runtime locates its build across config, env
    and default and proves an interpreter is in there, and only then is
    there a path worth handing to a filesystem.

    Args:
        host_root (str | None): the interpreter build directory, served
            read-only for every path no mount claims. None means the
            guest sees mounts and nothing else, which is the quickjs
            case, since qjs carries no files of its own.
    """

    host_root: str | None = None
