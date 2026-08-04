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

from mirage.policy.types import (Action, CommandContext, ExecuteContext,
                                 ExecuteResultContext, OpsContext,
                                 OpsResultContext)


class Policy:
    """One concern's answers to the workspace lifecycle.

    Subclasses override only the hooks they care about; a hook returns
    an Action to state an opinion or None to stay silent, and a hook
    that raises fails closed (the command or op is refused, naming the
    policy). Hooks left un-overridden are detected at the seam and
    never called.
    """

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        """Admit or refuse one classified command.

        Args:
            ctx (CommandContext): the classified command.
        """
        return None

    async def pre_execute(self, ctx: ExecuteContext) -> Action | None:
        """Steer or refuse one typed line before anything runs.

        Fires parse-before-dispatch, once per top-level line. A Deny
        refuses the line (exit 126, policy-denied wording); a Route
        places it on a named runtime, overriding the static bindings
        the way the ``runtime=`` argument does. The first Route wins.

        Args:
            ctx (ExecuteContext): the parsed line's facts.
        """
        return None

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        """Admit or refuse one VFS op, whatever door it entered.

        The hot path: fires per op (thousands under one recursive
        command), so keep the hook cheap; expensive decisions belong at
        pre_command or precomputed into policy state.

        Args:
            ctx (OpsContext): the op about to run.
        """
        return None

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        """Observe one completed VFS op; a Deny suppresses its result,
        a Limit caps a byte-producing one.

        Args:
            ctx (OpsResultContext): the op and its raw result.
        """
        return None

    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        """Bound one finished execute() line's output.

        A Limit returned here merges with every other opining policy's
        (tightest per field) and caps the line's stdout at the
        workspace boundary.

        Args:
            ctx (ExecuteResultContext): the finished line's facts.
        """
        return None
