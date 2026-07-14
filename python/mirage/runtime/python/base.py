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
class PythonRunArgs:
    """One `python3` execution request.

    Args:
        code (str): the Python source to run (script body or `-c` payload).
        args (list[str]): argv passed to the script after the code.
        env (dict[str, str]): extra environment merged over the runtime's own.
        stdin (bytes | None): bytes fed to the interpreter's stdin.
    """

    code: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    stdin: bytes | None = None


@dataclass(frozen=True, slots=True)
class PythonRunResult:
    """Outcome of one `python3` execution.

    Args:
        stdout (bytes): captured standard output.
        stderr (bytes | None): captured standard error, None when empty.
        exit_code (int): interpreter exit code.
    """

    stdout: bytes
    stderr: bytes | None
    exit_code: int


class PythonRuntime(ABC):
    """A Python interpreter the workspace can execute `python3` code on.

    Implementations own their interpreter lifecycle (lazy boot, reuse
    across runs, teardown in `close`). How an implementation sees
    workspace files is its own concern: an in-process interpreter bridges
    reads through the workspace dispatch, while a host subprocess only
    sees the host filesystem.
    """

    name: str

    @abstractmethod
    async def run(self, args: PythonRunArgs) -> PythonRunResult:
        """Execute one Python program and return its captured outcome."""

    async def close(self) -> None:
        """Release interpreter resources. Default: nothing to release."""
