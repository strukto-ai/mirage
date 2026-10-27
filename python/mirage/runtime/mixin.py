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
    splits the line. Only an explicit WHOLE_LINE capture delegates a whole
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
        self,
        engine: E,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
    ) -> RunResult:
        """Execute one raw command line wholesale, ``sh -c`` with it.

        Args:
            engine (E): the runtime's engine.
            paths (list[PathSpec]): unused; a line names its own paths.
            texts (list[str]): unused.
            ctx (Context): the line in ``flags["c"]``, its stdin, the
                session environment and working directory.
            output (OutputFn | None): receives stdout as it arrives,
                each write awaited, which the result then leaves out;
                None, or a transport that cannot stream, returns it
                whole. A runtime that leaves both sinks out of its
                signature is never handed them.
            errors (OutputFn | None): the same for stderr.
        """


class ProcessExecutorMixin(ABC, Generic[E]):
    """Execute an argv request without shell interpretation, its input
    read as the program consumes it and its output handed over as it
    comes."""

    @abstractmethod
    async def run_process(
        self,
        engine: E,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
    ) -> RunResult:
        """Run the program ``texts`` names, with ``ctx``'s working
        directory, environment and stdin, and return its status once it
        exits.

        Args:
            engine (E): the runtime's engine.
            paths (list[PathSpec]): unused; argv is words.
            texts (list[str]): the argv, program first.
            ctx (Context): the run's context; its stdin is read as the
                program consumes it.
            output (OutputFn | None): receives stdout as it arrives,
                each write awaited, which the result then leaves out;
                None, or a transport that cannot stream, returns it
                whole.
            errors (OutputFn | None): the same for stderr.
        """
