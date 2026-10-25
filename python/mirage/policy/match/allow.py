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
from mirage.rs.policy import admission_matcher, units


def head_allowed(name: str, rules: AdmissionRules | None) -> bool:
    """Whether a session's allow list has a pattern for a command name.

    A profile without an allow list allows everything; a profile with
    one allows the names its patterns start with, builtins included.
    Shell functions are the caller's exemption, not this one's.

    Args:
        name (str): the command name.
        rules (AdmissionRules | None): the session's admission rules.
    """
    return (
        admission_matcher(rules).ask("head_allowed", name=units(name)) is True
    )


def line_tokens(ctx: CommandContext) -> tuple[str, ...]:
    """The tokens a pattern reads: the entry point's normalization when it set
    one, else the name and the raw argv (a context built by hand).

    Args:
        ctx (CommandContext): the classified command.
    """
    return ctx.tokens or (ctx.command, *ctx.argv)


def line_allowed(ctx: CommandContext, rules: AdmissionRules | None) -> bool:
    """Whether the profile's allow list has a pattern for the line.

    A profile that states no list installs everything. A word that is not
    a tool (``ctx.tool`` cleared by the entry point: the agent's own function,
    an executed path) is always allowed here; a deny rule is the only
    thing that can refuse it.

    Args:
        ctx (CommandContext): the classified command.
        rules (AdmissionRules | None): the session's admission rules.
    """
    return (
        admission_matcher(rules).ask(
            "line_allowed",
            tokens=[units(v) for v in line_tokens(ctx)],
            tool=ctx.tool,
        )
        is True
    )
