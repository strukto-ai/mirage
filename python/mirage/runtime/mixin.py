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
from typing import Generic, TypeVar

from mirage.commands.config import Context
from mirage.runtime.types import OutputFn, RunResult
from mirage.types import PathSpec

E = TypeVar("E")


class LineExecutorMixin(ABC, Generic[E]):
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
        self, engine: E, paths: list[PathSpec], texts: list[str], ctx: Context
    ) -> RunResult:
        """Execute one raw command line wholesale, ``sh -c`` with it.

        Args:
            engine (E): the runtime's engine.
            paths (list[PathSpec]): unused; a line names its own paths.
            texts (list[str]): unused.
            ctx (Context): the line in ``flags["c"]``, its stdin, the
                session environment and working directory.
        """


class ProcessExecutorMixin(ABC, Generic[E]):
    """Execute an argv request without shell interpretation."""

    @abstractmethod
    async def run_process(
        self, engine: E, paths: list[PathSpec], texts: list[str], ctx: Context
    ) -> RunResult:
        """Run the program ``texts`` names, with ``ctx``'s working
        directory, environment and stdin.

        Args:
            engine (E): the runtime's engine.
            paths (list[PathSpec]): unused; argv is words.
            texts (list[str]): the argv, program first.
            ctx (Context): the run's context.
        """


class StreamingProcessMixin(ProcessExecutorMixin[E]):
    """An argv executor that consumes input and delivers output incrementally."""

    @abstractmethod
    async def run_stream(
        self,
        engine: E,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
        output: OutputFn,
    ) -> RunResult:
        """Await each output write and return status after the child exits.

        Args:
            engine (E): the runtime's engine.
            paths (list[PathSpec]): unused; argv is words.
            texts (list[str]): the argv, program first.
            ctx (Context): the run's context; its stdin is read as the
                child consumes it.
            output (OutputFn): where the child's stdout goes.
        """
