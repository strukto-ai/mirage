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

from mirage.runtime.types import EvalResult, EvalValue, RunResult


class EvaluatorMixin(ABC):
    """The evaluator capability: named inputs in, a value out.

    A true mixin: no state, no constructor, one method. A Runtime
    that also inherits this can evaluate expressions, which is what
    the routing policy engine and the repl consume; process-only
    runtimes never inherit it and are never asked to evaluate. The
    contract promises the shape, not value fidelity: inputs and the
    returned value stay within EvalValue so any transport can carry
    them, and errors surface as the evaluator's own diagnostics
    wrapped in EvalError.

    The language ``eval`` speaks is ``Runtime.language``, the same
    attribute ``run`` answers for: the policy engine matches it against
    a config script's extension so a .js policy lands on a JS
    evaluator. A separate name here would let one runtime claim two
    languages.
    """

    @abstractmethod
    async def eval(self,
                   code: str,
                   *,
                   inputs: dict[str, EvalValue] | None = None,
                   session: str | None = None) -> EvalResult:
        """Evaluate one program and return its last expression.

        Args:
            code (str): the source to evaluate.
            inputs (dict[str, EvalValue] | None): named values the
                program sees as globals, bound in the evaluator's own
                idiom.
            session (str | None): a session id for stateful console
                semantics (globals persist per id); None evaluates
                one-shot.

        Raises:
            EvalError: the program failed to parse, raised, or its
                value could not be carried back.
        """


class LineExecutorMixin(ABC):
    """The whole-line capability: a raw command line in, a result out.

    A true mixin: no state, no constructor, one method. A Runtime that
    also inherits this owns any line routed to it wholesale: pipes,
    redirects, and every command in the line run inside the runtime's
    world (its own cat, its own grep), the workspace shell never
    splits the line. A line lands on it when the runtime captures one
    of the line's commands or "*". Interpreter runtimes never inherit
    it: they are the engine inside one command (python3, node), never
    the line. The vfs runtime does not either: a line resolved to vfs
    runs on the workspace executor inline, so there is no delegate to
    call. Capability is detected by type (isinstance), never by
    probing for a method or a flag.
    """

    @abstractmethod
    async def run_line(self, line: str, stdin: bytes | None,
                       env: dict[str, str], cwd: str) -> RunResult:
        """Execute one raw command line wholesale.

        Args:
            line (str): the raw typed line.
            stdin (bytes | None): bytes piped into the line.
            env (dict[str, str]): the session environment.
            cwd (str): the session working directory.
        """
