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

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class JsRunArgs:
    """One `node`/`js` execution request.

    Args:
        code (str): the JavaScript source to run (script body or -e payload).
        args (list[str]): argv exposed to the script as `scriptArgs`.
        env (dict[str, str]): extra environment merged over the runtime's own.
        stdin (bytes | None): bytes fed to the interpreter's stdin.
        module (bool): run as an ES module (top-level import/export/await)
            rather than a classic script.
    """

    code: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    stdin: bytes | None = None
    module: bool = False


@dataclass(frozen=True, slots=True)
class JsRunResult:
    """Outcome of one `node`/`js` execution.

    Args:
        stdout (bytes): captured standard output.
        stderr (bytes | None): captured standard error, None when empty.
        exit_code (int): interpreter exit code.
    """

    stdout: bytes
    stderr: bytes | None
    exit_code: int


class JsRuntime(ABC):
    """A JavaScript engine the workspace can execute `node`/`js` code on.

    Implementations own their engine lifecycle (lazy boot, reuse across
    runs, teardown in `close`). Like the Python runtimes, a sandboxed
    engine sees only what the run passes it, not workspace mounts.
    """

    name: str

    @abstractmethod
    async def run(self, args: JsRunArgs) -> JsRunResult:
        """Execute one JavaScript program and return its captured outcome."""

    async def close(self) -> None:
        """Release engine resources. Default: nothing to release."""
