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
    CommandResultContext,
    ExecuteResultContext,
    NetworkContext,
    NetworkResultContext,
    RouteContext,
    SessionContext,
    SessionResultContext,
    VfsContext,
    VfsResultContext,
    WorkspaceContext,
)


class Policy:
    """One concern's answers to the workspace lifecycle.

    Subclasses override only the methods they care about; a method returns
    an Action to state an opinion, a tuple of them to state several
    (each read as if its own policy had said it, as a profile's
    programs answer), or None to stay silent, and a method that raises
    fails closed (the command or op is refused, naming the policy).
    Methods left un-overridden are detected at the seam and never called.

    The methods come in pairs, one per surface: the line
    (``pre_execute`` / ``post_execute``), each command or CLI
    (``pre_command`` / ``post_command``), each ``ws.vfs`` /
    ``session.vfs`` call (``pre_vfs`` / ``post_vfs``) and each session
    write (``pre_session`` / ``post_session``). Every method may answer
    Deny or Ask; a Limit only at ``post_execute``, where a line's output
    comes back to cap, a Route only at ``pre_execute``. One more,
    ``pre_workspace``, answers on a server before a workspace is built,
    with a Deny only.
    A post method sees what its pre method saw, plus what came back, and
    never undoes a side effect: it holds back what came back. Hides,
    mount modes and path rules are not methods: they apply to every
    caller at the dispatcher. Every method's context also carries the
    session (``session``) and its files (``vfs``), both read only: a
    method reads, and a write it makes is refused.
    """

    async def pre_execute(
        self, ctx: RouteContext
    ) -> Action | tuple[Action, ...] | None:
        """Place, hold or refuse one typed line before any of it runs.

        Fires once per line, after the profile's rules clear it (a line
        they refuse is never placed) and before it runs; a nested line
        keeps the placement of the line that ran it. A Route names the
        runtime that serves the line, a Deny refuses it whole (exit 126,
        ``<command>: Permission denied``) and an Ask holds it until the
        host approves. The workspace's ``route_policy`` answers here as a
        built-in, ahead of the policies registered in code.

        Args:
            ctx (RouteContext): the line and its commands.
        """
        return None

    async def pre_command(
        self, ctx: CommandContext
    ) -> Action | tuple[Action, ...] | None:
        """Admit, hold or refuse one command or CLI, once, as it runs.

        A Deny refuses it (``<command>: Permission denied``, exit 126, or
        the path's own error for a Deny about a path); an Ask holds it
        until the host approves. Its file I/O also passes the dispatcher's
        ``pre_vfs`` and ``post_vfs`` gates.

        Args:
            ctx (CommandContext): the classified command.
        """
        return None

    async def post_command(
        self, ctx: CommandResultContext
    ) -> Action | tuple[Action, ...] | None:
        """Judge one command or CLI once it ran and its output drained.

        A Deny, or an Ask the host has not approved, sets its exit code
        to 126 and records the refusal, so ``&&`` and ``pipefail`` stop
        there; output already sent stays sent.

        Args:
            ctx (CommandResultContext): what ``pre_command`` saw, plus the
                exit code, stderr and op records.
        """
        return None

    async def pre_vfs(
        self, ctx: VfsContext
    ) -> Action | tuple[Action, ...] | None:
        """Admit, hold or refuse one ``ws.vfs`` / ``session.vfs`` call.

        Fires at the dispatcher before any backend or cache I/O, for the
        host's and the agent's file calls, including commands, runtimes
        and FUSE. A Deny is EACCES; an Ask holds a standalone call until
        the host approves and refuses inside a running command.

        Args:
            ctx (VfsContext): the op about to run.
        """
        return None

    async def post_vfs(
        self, ctx: VfsResultContext
    ) -> Action | tuple[Action, ...] | None:
        """Judge one completed ``ws.vfs`` / ``session.vfs`` call.

        A Deny, or an Ask the host has not approved, drops the result
        with EACCES (the call itself is not undone). Nothing cuts a
        result: a kernel or protocol mount reads in ranges and must get
        each whole.

        Args:
            ctx (VfsResultContext): what ``pre_vfs`` saw, plus the result.
        """
        return None

    async def pre_network(
        self, ctx: NetworkContext
    ) -> Action | tuple[Action, ...] | None:
        """Admit or refuse one request a command sends.

        Fires before any connection opens, for ``curl``, ``wget`` and
        ``git`` over https. A Deny refuses it as a closed port would
        (``curl`` exits 7); an Ask refuses it too, since the line was
        admitted without it.

        Args:
            ctx (NetworkContext): the request about to be sent.
        """
        return None

    async def post_network(
        self, ctx: NetworkResultContext
    ) -> Action | tuple[Action, ...] | None:
        """Judge one finished request.

        Fires once the transfer ends, however it ends, so a method can
        count what is in flight. A Deny fails the command as a broken
        transfer; what it already wrote stays.

        Args:
            ctx (NetworkResultContext): what ``pre_network`` saw, plus
                how it ended.
        """
        return None

    async def pre_session(
        self, ctx: SessionContext
    ) -> Action | tuple[Action, ...] | None:
        """Admit, hold or refuse one session write (set, unset, mark).

        Fires on the session plane, so an ``export`` from the shell, a
        ``SessionView.set`` from a command, and any later writer clear
        the same gate. Not path-scoped on purpose: the context carries
        a key, never a pseudo-path.

        Args:
            ctx (SessionContext): the mutation about to land.
        """
        return None

    async def post_session(
        self, ctx: SessionResultContext
    ) -> Action | tuple[Action, ...] | None:
        """Judge one session write once it landed.

        A Deny, or an Ask the host has not approved, puts the old value
        back and refuses the write.

        Args:
            ctx (SessionResultContext): what ``pre_session`` saw, plus the
                value it replaced.
        """
        return None

    async def post_execute(
        self, ctx: ExecuteResultContext
    ) -> Action | tuple[Action, ...] | None:
        """Judge one finished line's output.

        A Deny, or an Ask the host has not approved, drops the output
        (exit 126, a refusal record); a Limit merges with every other
        opining policy's (tightest per field) and caps it at the
        workspace boundary.

        Args:
            ctx (ExecuteResultContext): what ``pre_execute`` saw, plus
                the exit code, the output and each command's result.
        """
        return None

    async def pre_workspace(
        self, ctx: WorkspaceContext
    ) -> Action | tuple[Action, ...] | None:
        """Refuse a workspace a server is about to build.

        Fires on a server's create, clone and load, before any mount is
        built or any secret the config names is read, for the policies
        the server was started with; a workspace's own policies cannot
        answer, as it does not exist yet. A Deny refuses the request
        with 403 and its reason; nothing else may be answered.

        Args:
            ctx (WorkspaceContext): the config and who asks.
        """
        return None
