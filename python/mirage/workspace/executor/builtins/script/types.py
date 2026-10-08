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

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class BashArgs:
    """One parsed ``bash``/``sh`` invocation.

    The two failure fields report what went wrong rather than a rendered
    message, the way ``ShellParse`` does: the wording and the exit code
    belong to the caller, which is the only thing that knows the head
    word the shell was spelled as.

    Args:
        script (str | None): inline program text from ``-c``.
        path (str | None): script file operand, as typed.
        argv (list[str]): words after the program, ``$0`` first for the
            ``-c`` form and all positional for the other two.
        settings (tuple[tuple[str, bool], ...]): shell options the
            startup flags turn on or off, in the order written.
        invalid (str | None): the option the shell refuses, as bash
            names it.
        needs_value (str | None): the option given no argument.
        help (bool): ``--help`` was given; bash answers it before
            ``--version`` and before reading anything else.
        version (bool): ``--version`` was given.
    """

    script: str | None = None
    path: str | None = None
    argv: list[str] = field(default_factory=list)
    settings: tuple[tuple[str, bool], ...] = ()
    invalid: str | None = None
    needs_value: str | None = None
    help: bool = False
    version: bool = False
