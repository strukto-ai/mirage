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

from mirage.context.session_context import (
    get_admission,
    line_running,
    redirect_target_judged,
)
from mirage.policy.base import Policy
from mirage.policy.match import Outcome, decide, op_ruling, posix_level
from mirage.policy.mixin import SessionScopedMixin
from mirage.policy.types import (
    Action,
    Ask,
    CommandContext,
    Deny,
    DenyScope,
    SessionCommandsQuery,
    VfsContext,
)


class PermissionsPolicy(Policy, SessionScopedMixin):
    """The profile's ``commands`` rules, enforced.

    Seeded by the workspace after ``MountRootPolicy`` (POSIX messages
    still win) and before user policies, so a document rule speaks
    before a coded one when both match. It reads the session's
    compiled rules through the narrow ``SessionCommandsQuery`` by the
    session id the entry point put in the context, never through ambient
    state: an explicit fact survives the thread hop that drops a
    contextvar. Verdicts render through the one outcome table
    (``render_deny``), so an agent cannot tell a document deny from a
    coded one.

    ``pre_command`` renders one ``decide`` call, which is where the
    law lives: the allow list first (a line it does not cover is
    refused whole, though its head was visible), then the winning rule,
    refused whole or per operand by whether it names paths, or taken to
    the approval entry point when it asks. ``pre_vfs`` walks the deny rules
    that are pure paths, so FUSE, programmatic ops and the warm cache
    cannot bypass a path the profile protects. A path rule that asks is
    a question only where no line is running (a file tool, the host's
    facade), which the entry point puts to the approval ledger keyed by rule
    and path; inside a line it refuses, since the line was admitted
    without it.

    Args:
        sessions (SessionCommandsQuery): the session manager, answering
            ``commands_of(session_id)``.
    """

    def __init__(self, sessions: SessionCommandsQuery) -> None:
        self._sessions = sessions

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        decision = decide(ctx, self._sessions.commands_of(ctx.session_id))
        if decision.outcome is Outcome.ALLOW:
            return None
        rule = decision.rule
        if rule is None:
            program = " ".join(ctx.program or (ctx.command,))
            return Deny(f"{program} is not allowed")
        if decision.outcome is Outcome.ASK:
            return Ask(rule.reason, rule, decision.asks)
        if decision.matched_path is None:
            return Deny(rule.reason, rule=rule)
        return Deny(
            rule.reason,
            DenyScope.OPERAND,
            path=decision.matched_path,
            rule=rule,
        )

    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        if redirect_target_judged(ctx.path.virtual):
            return None
        # The grants belong to the line, not the session: a once grant
        # is spent as the command is admitted, so by the time its own
        # walk reaches this entry point the session holds nothing and only the
        # bound gate still remembers the nod.
        gate = get_admission()
        granted = gate.granted if gate is not None else ()
        ruled = op_ruling(
            self._sessions.commands_of(ctx.session_id), ctx, granted
        )
        if ruled is None:
            return None
        rule, asks = ruled
        if asks and gate is None and not line_running():
            return Ask(rule.reason, rule)
        return Deny(rule.reason, rule=rule)

    async def wants_for(self, hook: str, session_id: str) -> bool:
        """Whether this session's rules speak at ``hook``: always at the
        command entry point, and at the dispatcher only through a pure path
        rule, the one kind an op can meet (``op_reach``).

        Args:
            hook (str): the hook in python spelling.
            session_id (str): the session the dispatcher serves.
        """
        if hook != "pre_vfs":
            return True
        rules = self._sessions.commands_of(session_id)
        if rules is None:
            return False
        return any(posix_level(rule) for rule in (*rules.deny, *rules.ask))
