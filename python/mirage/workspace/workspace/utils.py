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

from typing import Any

from mirage.commands.builtin.utils.identity import (
    Identity,
    home_of,
    session_uid,
    user_homes,
)
from mirage.workspace.session import SessionState
from mirage.workspace.session.session import vars_from_env
from mirage.workspace.session.state import seed_user


def command_name(command: str) -> str:
    """First word of a command line, the name diagnostics report.

    Args:
        command (str): the raw command line.

    Returns:
        str: the leading word, or "" when the line is blank.
    """
    words = command.split()
    return words[0] if words else ""


def fork_for_call(
    session: SessionState, cwd: str | None, env: dict[str, str] | None
) -> SessionState:
    """Session a single ``shell`` call runs in.

    A per-call ``cwd``/``env`` runs in an ephemeral clone, matching a
    bash subshell: ``cd`` and ``export`` inside the line do not leak
    back to the persistent session, and the clone runs as the same
    user. Without overrides the persistent session is used as is.

    Args:
        session (SessionState): the persistent session for the call.
        cwd (str | None): per-call working directory override.
        env (dict[str, str] | None): per-call environment overrides,
            layered on top of the session's env.
    """
    if cwd is None and env is None:
        return session
    overrides: dict[str, Any] = {}
    if cwd is not None:
        overrides["cwd"] = cwd
    if env is not None:
        overrides["vars"] = {**session.vars, **vars_from_env(env)}
    forked = session.fork(**overrides)
    seed_session_user(forked)
    return forked


def seed_session_user(session: SessionState) -> None:
    """Give a session the user its profile runs as: ``$UID``, ``$EUID``
    and the homes ``~`` reads, which a fork does not carry.

    Args:
        session (SessionState): the session a line runs in.
    """
    identity = Identity(profile=session.profile)
    seed_user(
        session, session_uid(identity), home_of(identity), user_homes(identity)
    )
