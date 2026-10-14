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

from mirage.runtime.types import ProcessExecution, RunResult, StreamExecution


class LineExecutorMixin(ABC):
    """The whole-line capability: a raw command line in, a result out.

    A true mixin: no state, no constructor, one method. A Runtime that
    also inherits this owns any line routed to it wholesale: pipes,
    redirects, and every command in the line run inside the runtime's
    world (its own cat, its own grep), the workspace shell never
    splits the line. Only an explicit "*" capture delegates a whole
    workspace line. Named captures receive one safely quoted command.
    Interpreter runtimes never inherit
    it: they are the engine inside one command (python3, node), never
    the line. The workspace runtime does not either: a line resolved to
    workspace runs on the workspace executor inline, so there is no delegate
    to call. Capability is detected by type (isinstance), never by
    probing for a method or a flag.
    """

    @abstractmethod
    async def run_line(
        self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
    ) -> RunResult:
        """Execute one raw command line wholesale.

        Args:
            line (str): the raw typed line.
            stdin (bytes | None): bytes piped into the line.
            env (dict[str, str]): the session environment.
            cwd (str): the session working directory.
        """


class ProcessExecutorMixin(ABC):
    """Execute an argv request without shell interpretation."""

    @abstractmethod
    async def run_process(self, request: ProcessExecution) -> RunResult:
        """Run a process with the request's cwd, environment and stdin."""


class StreamingProcessMixin(ProcessExecutorMixin):
    """An argv executor that consumes input and delivers output incrementally."""

    @abstractmethod
    async def run_stream(self, request: StreamExecution) -> RunResult:
        """Await each output write and return status after the child exits."""
