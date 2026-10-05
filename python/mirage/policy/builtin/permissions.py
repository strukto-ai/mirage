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
    redirect_target_judged,
)
from mirage.policy.base import Policy
from mirage.policy.match import Outcome, decide, op_refusal, rule_scope
from mirage.policy.mixin import SessionScopedMixin
from mirage.policy.types import (
    Action,
    Ask,
    CommandContext,
    Deny,
    DenyScope,
    OpsContext,
    SessionCommandsQuery,
)


class PermissionsPolicy(Policy, SessionScopedMixin):
    """The profile's ``commands`` rules, enforced.

    Seeded by the workspace after ``MountRootPolicy`` (POSIX messages
    still win) and before user policies, so a document rule speaks
    before a coded one when both match. It reads the session's
    compiled rules through the narrow ``SessionCommandsQuery`` by the
    session id the door put in the context, never through ambient
    state: an explicit fact survives the thread hop that drops a
    contextvar. Verdicts render through the one outcome table
    (``render_deny``), so an agent cannot tell a document deny from a
    coded one.

    ``pre_command`` renders one ``decide`` call, which is where the
    law lives: the allow list first (a line it does not cover is
    refused whole, though its head was visible), then the winning rule,
    refused whole or per operand by whether it names paths, or taken to
    the approval door when it asks. ``pre_ops`` walks the deny rules
    that are pure paths, so FUSE, programmatic ops and the warm cache
    cannot bypass a path the profile protects; there is no ask at the op
    door, which cannot wait on a host.

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
            return Deny(rule.reason)
        return Deny(
            f"{decision.matched_path}: {rule.reason}", DenyScope.OPERAND
        )

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if redirect_target_judged(ctx.path.virtual):
            return None
        # The grants belong to the line, not the session: a once grant
        # is spent as the command is admitted, so by the time its own
        # walk reaches this door the session holds nothing and only the
        # bound gate still remembers the nod.
        gate = get_admission()
        granted = gate.granted if gate is not None else ()
        reason = op_refusal(
            self._sessions.commands_of(ctx.session_id), ctx, granted
        )
        return Deny(reason) if reason is not None else None

    async def wants_for(self, hook: str, session_id: str) -> bool:
        """Whether this session's rules speak at ``hook``: always at the
        command door, and at the op door only through a pure path rule,
        the one kind an op can meet (``op_reach``).

        Args:
            hook (str): the hook in python spelling.
            session_id (str): the session the door serves.
        """
        if hook != "pre_ops":
            return True
        rules = self._sessions.commands_of(session_id)
        if rules is None:
            return False
        return any(
            not rule.commands and rule_scope(rule) is not None
            for rule in (*rules.deny, *rules.ask)
        )
