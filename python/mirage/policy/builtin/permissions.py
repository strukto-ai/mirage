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

from mirage.policy.base import Policy
from mirage.policy.match import Outcome, decide
from mirage.policy.types import (
    Action,
    Ask,
    CommandContext,
    Deny,
    SessionCommandsQuery,
)


class PermissionsPolicy(Policy):
    """The profile's command trees, enforced.

    Seeded by the workspace after ``MountRootPolicy`` (POSIX messages
    still win) and before user policies, so a document rule speaks
    before a coded one when both match. It reads the session's
    compiled trees through the narrow ``SessionCommandsQuery`` by the
    session id the entry point put in the context, never through ambient
    state: an explicit fact survives the thread hop that drops a
    contextvar. Verdicts render through the one outcome table
    (``render_deny``), so an agent cannot tell a document deny from a
    coded one.

    ``pre_command`` renders one ``decide`` call, which is where the
    law lives: the leaf that decided refuses the line, or takes it to
    the approval ledger when it asks. A tree judges lines only; what
    every entry point must keep from a path is a hide.

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
        assert rule is not None
        if decision.outcome is Outcome.ASK:
            return Ask(rule.reason, rule, decision.asks)
        return Deny(
            rule.reason,
            path=decision.matched_path,
            rule=rule,
            matched=decision.matched,
        )
