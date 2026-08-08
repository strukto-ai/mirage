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

from abc import abstractmethod
from typing import ClassVar

from mirage.runtime.base import Runtime
from mirage.runtime.types import (DispatchFn, Language, PrefixSource, RunArgs,
                                  RunResult)


class LanguageRuntime(Runtime):
    """A runtime that interprets one language's code inside a command.

    The engine inside a single command (python3, node): the workspace
    splits the line, and a captured stage's code lands here as run().
    Never the whole line; that is LineExecutorMixin's door.

    The language it interprets is declared once, for both doors: run()
    for a script CLI (runtime_for_language) and eval() for a
    config-borne policy script (evaluator_of). One attribute, because
    two would let a runtime claim python at one door and js at the
    other, and the disagreement would only surface as an unexplained
    127 or a policy evaluated on the wrong engine. Concrete runtimes
    inherit it from their language tier (PythonRuntime, JsRuntime)
    rather than declaring it per class.

    How an implementation sees workspace files is its own concern: a
    sandboxed interpreter bridges file I/O through the workspace
    dispatch attached here, while a host subprocess only sees the host
    filesystem and keeps the default no-op attach.
    """

    language: ClassVar[Language]

    def attach(self, dispatch: DispatchFn,
               mount_prefixes: PrefixSource) -> None:
        """Late-wire workspace I/O into a user-constructed instance.

        Config-built and user-passed runtimes exist before the
        workspace they serve, so the workspace attaches its dispatch
        at construction. Runtimes that never touch workspace files (a
        host subprocess) keep the default no-op.

        Args:
            dispatch (DispatchFn): workspace op dispatch the sandboxed
                runtime bridges file I/O through.
            mount_prefixes (PrefixSource): live list of workspace
                mount prefixes, read per run.
        """

    @abstractmethod
    async def run(self, args: RunArgs) -> RunResult:
        """Execute one program and return its captured outcome.

        Args:
            args (RunArgs): the execution request.
        """
