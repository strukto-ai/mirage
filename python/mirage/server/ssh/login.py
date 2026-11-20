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

import errno
import logging
import secrets
import shlex
from collections.abc import Mapping

import asyncssh
from asyncssh.connection import SSHConnection

from mirage import Workspace
from mirage.server.metrics import refused
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry
from mirage.server.ssh.constants import (
    ACCOUNT_OPTION,
    PROFILE_OPTION,
    ROUTE_ACCOUNT,
)
from mirage.server.ssh.errors import LoginRefusedError

logger = logging.getLogger(__name__)


def new_session_id() -> str:
    return f"ssh_{secrets.token_hex(6)}"


def login_env(process: asyncssh.SSHServerProcess[str]) -> dict[str, str]:
    """The environment sshd hands a login: who, from where, on what.

    The user is the workspace id, since that is the name the client
    logged in as. ``HOME`` is the session's own, its user's home.

    Args:
        process (asyncssh.SSHServerProcess[str]): the channel's process.

    Returns:
        dict[str, str]: variable name to value.
    """
    user = process.get_extra_info("username")
    env = {"USER": user, "LOGNAME": user}
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
    """The account the login belongs to, if any.

    A login the HTTPS route carried runs as the account its token
    named (``ROUTE_ACCOUNT``). Otherwise the key's line in
    authorized_keys names it with ``mirage-account="<name>"``; the
    account may open only the workspaces it owns. A key without the
    option has no account.

    Args:
        conn (SSHConnection): the authenticated login's connection.
    """
    routed = conn.get_extra_info(ROUTE_ACCOUNT)
    if isinstance(routed, str):
        return routed
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
    registry: WorkspaceRegistry | None = None,
) -> None:
    """Create the session a channel runs as.

    The session runs under ``profile`` (the login key's), else the
    workspace's default profile. The login environment is exported by
    an unrecorded line, so a hidden name is refused as any ``export`` of
    it would be, and a name the profile already set keeps its value.

    Args:
        ws (Workspace): the workspace, on its own loop.
        session_id (str): the new session's id.
        env (Mapping[str, str] | None): the login environment.
        profile (str | None): the profile the login key is bound to;
            None for the workspace default.
        registry (WorkspaceRegistry | None): the server's workspaces,
            whose shutdown and ``max_sessions`` refuse a new session.

    Raises:
        PolicyError: the workspace has no such profile.
        OSError: EAGAIN while the server shuts down or the workspace is
            at ``max_sessions``.
    """
    await ws.ensure_sessions_loaded()
    if registry is not None and registry.draining:
        refused("shutting_down")
        raise OSError(errno.EAGAIN, "server is shutting down")
    cap = registry.max_sessions if registry is not None else None
    if cap is not None and len(ws.list_sessions()) >= cap:
        refused("max_sessions")
        raise OSError(errno.EAGAIN, f"workspace is at max_sessions ({cap})")
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


async def login_session(
    registry: WorkspaceRegistry,
    conn: SSHConnection,
    env: Mapping[str, str] | None,
    door: str,
) -> tuple[WorkspaceEntry, str]:
    """The login's workspace and a fresh session opened in it, under the
    login key's profile, else the workspace's default.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        conn (SSHConnection): the authenticated login's connection.
        env (Mapping[str, str] | None): the session's login environment.
        door (str): the channel's kind, for the log.

    Returns:
        tuple[WorkspaceEntry, str]: the workspace and the session id.

    Raises:
        LoginRefusedError: the workspace is out of reach, or the session
            cannot open.
    """
    workspace_id = conn.get_extra_info("username")
    entry = login_entry(registry, conn, workspace_id)
    if entry is None:
        raise LoginRefusedError(f"no such workspace: {workspace_id}")
    session_id = new_session_id()
    runner = entry.runner
    try:
        profile = key_profile(conn)
        await runner.call(
            open_session(runner.ws, session_id, env, profile, registry)
        )
    except Exception as exc:
        logger.warning(
            "%s: cannot open a session on %s: %r", door, workspace_id, exc
        )
        raise LoginRefusedError(f"cannot open a session: {exc}") from exc
    return entry, session_id


def refuse(process: asyncssh.SSHServerProcess[str], message: str) -> None:
    """Tell the client why its channel cannot run, and exit it 1.

    Args:
        process (asyncssh.SSHServerProcess[str]): the channel's process.
        message (str): the reason, after ``mirage: ``.
    """
    process.stderr.write(f"mirage: {message}\n")
    process.exit(1)


async def open_login(
    registry: WorkspaceRegistry,
    process: asyncssh.SSHServerProcess[str],
    door: str,
) -> tuple[WorkspaceEntry, str] | None:
    """The login's workspace and a fresh session opened in it
    (``login_session``), with the environment an ``ssh`` login gets. A
    login refused is told why and its channel exits 1.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        process (asyncssh.SSHServerProcess[str]): the channel's process.
        door (str): the channel's kind, for the log.

    Returns:
        tuple[WorkspaceEntry, str] | None: the workspace and the session
        id, or None once the channel has exited.
    """
    try:
        return await login_session(
            registry,
            process.channel.get_connection(),
            login_env(process),
            door,
        )
    except LoginRefusedError as exc:
        refuse(process, str(exc))
        return None


def still_served(registry: WorkspaceRegistry, entry: WorkspaceEntry) -> bool:
    """Whether the registry still serves the workspace a channel opened in,
    not one deleted, or created again under its id since.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        entry (WorkspaceEntry): the workspace the channel opened in.
    """
    return entry.id in registry and registry.get(entry.id) is entry
