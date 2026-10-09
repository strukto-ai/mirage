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

from mirage.policy.types import (
    Action,
    CommandContext,
    ExecuteResultContext,
    SessionContext,
    VfsContext,
    VfsResultContext,
)
from mirage.runtime.routing.types import RouteContext


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

    async def pre_execute(self, ctx: RouteContext) -> Action | None:
        """Place or refuse one typed line before any of it runs.

        Fires once per line, after the line clears admission (a line a
        rule refuses is never placed) and before it runs, with the
        payload a ``route_policy`` reads; a nested line keeps the
        placement of the line that ran it. A Route names the runtime
        that serves the line, and a Deny refuses it whole, exit 126 and
        ``<command>: Permission denied``. The workspace's
        ``route_policy`` answers here as a built-in, ahead of the
        policies registered in code.

        Args:
            ctx (RouteContext): the line, its commands, cwd and session.
        """
        return None

    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        """Admit or refuse one VFS op, at the dispatcher and on the
        command tier's backend I/O.

        The entry points are the dispatcher and ``ws.vfs``, which is also
        how FUSE, the runtime guests, ``find -delete`` and the warm
        cache arrive; a mount command's handler (cat, grep -r, sed -i,
        rm) admits each content read, mutation and readdir through the
        same hook (``with_policy_guard``), before its own warm cache.
        On that tier the op is named by adapter slot (read_bytes,
        read_stream, rm_r, ...), so a policy portable across the tiers
        keys on ``write`` and ``path``; stat/exists and native find/du
        enumeration stay unguarded as presence facts (mode-000 shape: a
        denied entry lists and stats, the read of it fails), and a
        native subtree op (rm_r, dir_copy) admits as the one op the
        backend performs.

        The hot path: fires per op (thousands under one recursive
        command), so keep the hook cheap; expensive decisions belong at
        pre_command or precomputed into policy state.

        Args:
            ctx (VfsContext): the op about to run.
        """
        return None

    async def pre_session(self, ctx: SessionContext) -> Action | None:
        """Admit or refuse one session-state mutation (an env write).

        Fires on the session plane, so an ``export`` from the shell, a
        ``SessionView.set`` from a command, and any later writer clear
        the same gate. Not path-scoped on purpose: the context carries
        a key, never a pseudo-path.

        Args:
            ctx (SessionContext): the mutation about to land.
        """
        return None

    async def post_vfs(self, ctx: VfsResultContext) -> Action | None:
        """Observe one completed VFS op; a Deny suppresses its result,
        a Limit caps a byte-producing one.

        Narrower than pre_vfs: the dispatcher and facade entry points only.
        The backend I/O inside a mount command's handler and each
        ``find -delete`` deletion admit through pre_vfs and report no
        per-op result here; the command tier's result plane is
        post_execute, which bounds the finished line's output.

        Args:
            ctx (VfsResultContext): the op and its raw result.
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
