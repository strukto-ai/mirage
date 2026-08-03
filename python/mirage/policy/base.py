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

from mirage.policy.types import Action, CommandContext


class Policy:
    """One concern's answers to the workspace lifecycle.

    Subclasses override only the hooks they care about; a hook returns
    an Action to state an opinion or None to stay silent, and a hook
    that raises fails closed (the command is refused, naming the
    policy). Hooks left un-overridden are detected at the seam and
    never called.

    pre_command fires once per classified command (including pipe
    segments and nested evals), before flag parsing, mount resolution,
    runtime placement, and backend I/O. Further lifecycle hooks
    (pre/post execute, pre/post ops) arrive with their seams.
    """

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        """Admit or refuse one classified command.

        Args:
            ctx (CommandContext): the classified command.
        """
        return None
