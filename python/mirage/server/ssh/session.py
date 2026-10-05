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

import asyncio
import concurrent.futures
import logging
import secrets
import shlex
from collections.abc import Mapping

import asyncssh
from asyncssh.connection import SSHConnection

from mirage import Workspace
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry
from mirage.server.ssh.constants import ACCOUNT_OPTION, PROFILE_OPTION
from mirage.server.ssh.stream import (
    ChannelInput,
    ChannelOutput,
    Mark,
    Send,
    decode,
    deliver,
    encode,
    loop_sender,
)
from mirage.server.stdin import LoopStdin
from mirage.workspace.abort import MirageAbortError
from mirage.workspace.executor.statement import record_status

logger = logging.getLogger(__name__)

AGENT_ID = "ssh"
INTERRUPTED = 130
PROMPT = "mirage:{cwd}$ "
FALLBACK_PROMPT = "mirage$ "
LOGIN_HOME = "/"


def new_session_id() -> str:
    return f"ssh_{secrets.token_hex(6)}"


def ends_shell(line: str) -> bool:
    """Whether a typed line asks the interactive shell to leave.

    mirage contains ``exit`` within the line it runs, so the shell reads
    the words instead: ``exit`` or ``exit N`` leaves, while ``exit 1 2``
    is bash's "too many arguments" and stays.

    Args:
        line (str): the line as typed.
    """
    words = line.split()
    return bool(words) and words[0] == "exit" and len(words) <= 2


def login_env(process: asyncssh.SSHServerProcess[str]) -> dict[str, str]:
    """The environment sshd hands a login: who, from where, on what.

    ``HOME`` is ``/``, where every session starts, and the user is the
    workspace id, since that is the name the client logged in as.

    Args:
        process (asyncssh.SSHServerProcess[str]): the channel's process.

    Returns:
        dict[str, str]: variable name to value.
    """
    user = process.get_extra_info("username")
    env = {"HOME": LOGIN_HOME, "USER": user, "LOGNAME": user}
    peer = process.get_extra_info("peername")
    local = process.get_extra_info("sockname")
    if peer and local:
        env["SSH_CLIENT"] = f"{peer[0]} {peer[1]} {local[1]}"
        env["SSH_CONNECTION"] = f"{peer[0]} {peer[1]} {local[0]} {local[1]}"
    if process.term_type:
        env["TERM"] = process.term_type
    return env


def _key_option(conn: SSHConnection, option: str, what: str) -> str | None:
    """The one value the login's authorized key gives ``option``.

    Args:
        conn (SSHConnection): the authenticated login's connection.
        option (str): the authorized_keys option to read.
        what (str): what the value names, for the refusal.

    Raises:
        TypeError: ``conn`` is not the server side of a connection.
        ValueError: the option is bare, empty or given more than once.
    """
    if not isinstance(conn, asyncssh.SSHServerConnection):
        raise TypeError("a key's option is read off a server connection")
    values = conn.get_key_option(option)
    if values is None:
        return None
    names = values if isinstance(values, list) else [values]
    name = names[0] if len(names) == 1 else None
    if not isinstance(name, str) or not name:
        raise ValueError(f"{option} must name exactly one {what}")
    return name


def key_profile(conn: SSHConnection) -> str | None:
    """The profile the login's authorized key is bound to, if any.

    The key's line in authorized_keys names it with
    ``mirage-profile="<name>"``; a key without the option runs under the
    workspace's default profile.

    Args:
        conn (SSHConnection): the authenticated login's connection.
    """
    return _key_option(conn, PROFILE_OPTION, "profile")


def key_account(conn: SSHConnection) -> str | None:
    """The account the login's authorized key belongs to, if any.

    The key's line in authorized_keys names it with
    ``mirage-account="<name>"``; the account may open only the
    workspaces it owns. A key without the option has no account.

    Args:
        conn (SSHConnection): the authenticated login's connection.
    """
    return _key_option(conn, ACCOUNT_OPTION, "account")


def login_entry(
    registry: WorkspaceRegistry, conn: SSHConnection, workspace_id: str
) -> WorkspaceEntry | None:
    """The workspace a login may open, else None.

    One rule for every channel kind: the key's account must be allowed
    the workspace its username names. A key whose account option is
    malformed opens nothing.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        conn (SSHConnection): the authenticated login's connection.
        workspace_id (str): the workspace the username names.
    """
    try:
        account = key_account(conn)
    except ValueError as exc:
        logger.warning("ssh: refusing %s: %s", workspace_id, exc)
        return None
    return registry.visible(workspace_id, account)


async def open_session(
    ws: Workspace,
    session_id: str,
    env: Mapping[str, str] | None = None,
    profile: str | None = None,
) -> None:
    """Create the session a channel runs as.

    The session runs under ``profile`` (the login key's), else the
    workspace's default profile. The login environment is exported by
    an unrecorded line, so every name clears the session's
    ``pre_session`` gate like any ``export`` would, and a name the
    profile already set keeps its value.

    Args:
        ws (Workspace): the workspace, on its own loop.
        session_id (str): the new session's id.
        env (Mapping[str, str] | None): the login environment.
        profile (str | None): the profile the login key is bound to;
            None for the workspace default.

    Raises:
        PolicyError: the workspace has no such profile.
    """
    await ws.ensure_sessions_loaded()
    session = ws.create_session(session_id, profile=profile)
    try:
        missing = {
            k: v for k, v in (env or {}).items() if k not in session.env
        }
        if not missing:
            return
        line = "export " + " ".join(
            f"{k}={shlex.quote(v)}" for k, v in missing.items()
        )
        io = await ws.shell(line, session_id=session_id, record=False)
        if io.exit_code != 0:
            logger.debug(
                "ssh: login env refused on %s: %s",
                session_id,
                await io.stderr_str(),
            )
    except BaseException:
        await ws.close_session(session_id)
        raise


async def run_line(
    ws: Workspace, session_id: str, line: str, stdin: LoopStdin, send: Send
) -> int:
    """Run one line as the session and stream its output back.

    Runs on the workspace's loop. The status is read after the streams
    drain, because a streaming command settles it only then.

    Args:
        ws (Workspace): the workspace.
        session_id (str): the session the line runs as.
        line (str): the shell line.
        stdin (LoopStdin): the channel's input.
        send (Send): where output goes.

    Returns:
        int: the line's exit status.
    """
    try:
        io = await ws.shell(
            line, session_id=session_id, stdin=stdin, agent_id=AGENT_ID
        )
    except MirageAbortError:
        return INTERRUPTED
    await deliver(io.stdout, io.stderr, send)
    return io.exit_code


async def stamp_interrupt(ws: Workspace, session_id: str) -> None:
    """Leave ``$?`` at 130 after a Ctrl-C, as an interactive bash does.

    An aborted line puts ``$?`` back to what it found, because an
    abandoned invocation is the caller's outcome; an interactive shell
    is the caller here, and its outcome for an interrupted foreground
    line is 128 + SIGINT.

    Args:
        ws (Workspace): the workspace, on its own loop.
        session_id (str): the session the line ran as.
    """
    record_status(ws.get_session(session_id), INTERRUPTED)


class ShellChannel:
    """One SSH session channel, run as one mirage session of its own.

    A command channel (``ssh host cmd``) runs its line and ends, and a
    shell channel reads lines until ``exit`` or end of input, printing a
    prompt when the client asked for a terminal. The session is fresh
    per channel, as each channel is a fresh process under sshd, so a
    ``cd`` never leaks from one channel to another and two channels
    never wait on each other's lines.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        entry (WorkspaceEntry): the workspace this channel serves.
        session_id (str): the session the channel runs as.
        process (asyncssh.SSHServerProcess[str]): the channel's process.
    """

    def __init__(
        self,
        registry: WorkspaceRegistry,
        entry: WorkspaceEntry,
        session_id: str,
        process: asyncssh.SSHServerProcess[str],
    ) -> None:
        self._registry = registry
        self._entry = entry
        self._session_id = session_id
        self._process = process
        self._tty = process.term_type is not None
        self._input = ChannelInput(process)
        self._output = ChannelOutput(process, self._tty)
        self._running: concurrent.futures.Future[int] | None = None
        self._lost = False

    def _live(self) -> bool:
        wid = self._entry.id
        return wid in self._registry and self._registry.get(wid) is self._entry

    def _interrupt(self) -> None:
        if self._running is not None:
            self._running.cancel()

    async def _watch_close(self) -> None:
        await self._process.wait_closed()
        self._lost = True
        self._interrupt()

    def _prompt(self) -> str:
        if not self._live():
            return FALLBACK_PROMPT
        cwd = self._entry.runner.ws.get_session(self._session_id).cwd
        return PROMPT.format(cwd=cwd)

    async def serve(self) -> int:
        """Run the channel to its end.

        Returns:
            int: the exit status to report to the client.
        """
        self._input.start()
        watch = asyncio.create_task(self._watch_close())
        try:
            if self._process.command is not None:
                return await self.run(self._process.command)
            return await self.repl()
        finally:
            watch.cancel()
            await asyncio.wait([watch])
            await self._input.close()
            if self._live():
                runner = self._entry.runner
                await runner.call(runner.ws.close_session(self._session_id))

    async def run(self, line: str) -> int:
        """Run one line on the workspace's loop, streaming its output.

        Ctrl-C and a dropped connection cancel the line where it is.

        Args:
            line (str): the shell line.

        Returns:
            int: the line's status; 130 when it was interrupted.
        """
        if not self._live():
            await self._output.write(
                b"mirage: the workspace is gone\n", stderr=True
            )
            return 1
        runner = self._entry.runner
        loop = asyncio.get_running_loop()
        self._running = asyncio.run_coroutine_threadsafe(
            run_line(
                runner.ws,
                self._session_id,
                line,
                LoopStdin(self._input, loop),
                loop_sender(self._output, loop),
            ),
            runner.loop,
        )
        self._input.on_interrupt(self._interrupt)
        try:
            return await asyncio.wrap_future(self._running)
        except asyncio.CancelledError:
            task = asyncio.current_task()
            if task is not None and task.cancelling():
                raise
            if self._lost:
                return INTERRUPTED
            if self._live():
                await runner.call(stamp_interrupt(runner.ws, self._session_id))
            if self._tty:
                await self._output.write(b"^C\n")
            return INTERRUPTED
        except Exception as exc:
            if self._lost:
                logger.debug("ssh: line ended with the connection: %r", exc)
                return 1
            logger.warning("ssh: line failed on %s: %r", self._entry.id, exc)
            await self._output.write(encode(f"mirage: {exc}\n"), stderr=True)
            return 1
        finally:
            self._input.on_interrupt(None)
            self._running = None

    async def repl(self) -> int:
        """Read and run lines until ``exit`` or end of input.

        Returns:
            int: the status of the last line run.
        """
        status = 0
        while not self._lost:
            if self._tty:
                await self._output.write(encode(self._prompt()))
            item = await self._input.readline()
            if item is Mark.LIMIT:
                await self._output.write(
                    b"mirage: shell input line too long\n", stderr=True
                )
                return 1
            if item is Mark.EOF:
                if self._tty:
                    await self._output.write(b"logout\n")
                return status
            if item is Mark.INTERRUPT:
                if self._tty:
                    await self._output.write(b"^C\n")
                status = INTERRUPTED
                if self._live():
                    runner = self._entry.runner
                    await runner.call(
                        stamp_interrupt(runner.ws, self._session_id)
                    )
                continue
            line = decode(item).rstrip("\r\n")
            if not line.strip():
                continue
            status = await self.run(line)
            if ends_shell(line) or not self._live():
                return status
        return status


async def handle_process(
    registry: WorkspaceRegistry, process: asyncssh.SSHServerProcess[str]
) -> None:
    """Serve one session channel: a command, or an interactive shell.

    The SSH username names the workspace. SFTP and scp never reach
    here: asyncssh hands them to the SFTP server.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        process (asyncssh.SSHServerProcess[str]): the channel's process.
    """
    workspace_id = process.get_extra_info("username")
    if process.subsystem is not None:
        process.stderr.write(
            f"mirage: unsupported subsystem: {process.subsystem}\n"
        )
        process.exit(1)
        return
    entry = login_entry(
        registry, process.channel.get_connection(), workspace_id
    )
    if entry is None:
        process.stderr.write(f"mirage: no such workspace: {workspace_id}\n")
        process.exit(1)
        return
    session_id = new_session_id()
    runner = entry.runner
    try:
        profile = key_profile(process.channel.get_connection())
        await runner.call(
            open_session(runner.ws, session_id, login_env(process), profile)
        )
    except Exception as exc:
        logger.warning(
            "ssh: cannot open a session on %s: %r", workspace_id, exc
        )
        process.stderr.write(f"mirage: cannot open a session: {exc}\n")
        process.exit(1)
        return
    status = await ShellChannel(registry, entry, session_id, process).serve()
    process.exit(status)
