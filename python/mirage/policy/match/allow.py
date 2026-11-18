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

from mirage.policy.types import AdmissionRules, CommandContext
from mirage.rs.document import units
from mirage.rs.policy import admission_matcher


def line_tokens(ctx: CommandContext) -> tuple[str, ...]:
    """The tokens a tree walks when the line has no read: the entry
    point's normalization when it set one, else the name and the raw
    argv (a context built by hand).

    Args:
        ctx (CommandContext): the classified command.
    """
    return ctx.tokens or (ctx.command, *ctx.argv)


def runs(name: str, rules: AdmissionRules | None) -> bool:
    """Whether a session can run a command at all: no tree that holds
    everywhere denies every line of it. A tree written under one mount
    refuses it only on a line working inside that mount, which the
    shell judges line by line, so the command still runs.

    Args:
        name (str): the command name.
        rules (AdmissionRules | None): the session's command trees.
    """
    return (
        rules is None
        or admission_matcher(rules).ask("runs", name=units(name)) is True
    )
