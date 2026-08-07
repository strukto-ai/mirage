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

from abc import ABC
from collections.abc import Sequence
from typing import Any, Callable, ClassVar

from mirage.runtime.config import RuntimeConfig
from mirage.runtime.types import ScriptSource


class Runtime(ABC):
    """An engine the workspace can route commands or whole lines to.

    A runtime is to its commands what the regex engine is to grep: the
    machinery inside a handler, invisible to the dispatcher. Each
    runtime declares the command names it captures; a command binds to
    the first runtime in the workspace's ordered list that captures
    it. Implementations own their engine lifecycle (lazy boot, reuse
    across runs, teardown in close).

    The base holds only what every tier shares: the registry name, the
    captured command names, the coerced config, and the per-line
    admission script. What a runtime can DO is declared by its tier
    and mixins, detected by type and never by probing: LanguageRuntime
    interprets one command's code (run), LineExecutorMixin takes whole
    lines (run_line), EvaluatorMixin evaluates expressions (eval).
    """

    name: str
    captures: tuple[str, ...] = ()
    # Per-line admission script for the routing ladder, answering "do
    # I want this line": a callable taking a PolicyContext, or a
    # config-borne ScriptSource. None = always willing. Policy, not
    # capability: it can only refuse lines the captures already allow.
    script: Callable[..., Any] | ScriptSource | None = None
    # Each runtime's config class; coerce() makes unknown fields fail
    # loud, so runtimes need no per-field rejection code.
    config_cls: ClassVar[type[RuntimeConfig]] = RuntimeConfig
    config: RuntimeConfig = RuntimeConfig()

    def __init__(
            self,
            captures: Sequence[str] | None = None,
            config: RuntimeConfig | dict[str, Any] | None = None,
            script: Callable[..., Any] | ScriptSource | None = None) -> None:
        """Every runtime is constructed the same way.

        Args:
            captures (Sequence[str] | None): commands this runtime
                claims, overriding the class default; ("*",) claims
                every line for a line-executing runtime. None keeps
                the default.
            config (RuntimeConfig | dict[str, Any] | None): the
                runtime's implementation knobs, coerced through its
                own config class (config_cls), so a field the runtime
                does not have fails loud; the dict form is a yaml
                entry's ``config`` block.
            script (Callable | ScriptSource | None): per-line
                admission script for the routing ladder.
        """
        if captures is not None:
            self.captures = tuple(captures)
        self.config = self.config_cls.coerce(config)
        self.script = script

    async def close(self) -> None:
        """Release engine resources. Default: nothing held."""
