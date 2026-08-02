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

from mirage.resource.history import HISTORY_PREFIX
from mirage.workspace.session import Session


def command_name(command: str) -> str:
    """First word of a command line, the name diagnostics report.

    Args:
        command (str): the raw command line.

    Returns:
        str: the leading word, or "" when the line is blank.
    """
    words = command.split()
    return words[0] if words else ""


def fork_for_call(session: Session, cwd: str | None,
                  env: dict[str, str] | None) -> Session:
    """Session a single ``execute`` call runs in.

    A per-call ``cwd``/``env`` runs in an ephemeral clone, matching a
    bash subshell: ``cd`` and ``export`` inside the line do not leak
    back to the persistent session. Without overrides the persistent
    session is used as is.

    Args:
        session (Session): the persistent session for the call.
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
        overrides["env"] = {**session.env, **env}
    return session.fork(**overrides)


def infrastructure_prefixes(implicit_root: bool) -> set[str]:
    """Mount prefixes a session is always allowed to touch.

    The implicit scratch root (where text-processing commands like
    ``wc`` without a path argument resolve), the device mount, and the
    history view are infrastructure: they hold no user credentials, and
    rejecting them would break common shell idioms or the history
    builtin. A user-defined root mount is NOT infrastructure; sessions
    must be granted ``/`` explicitly to touch it.

    Args:
        implicit_root (bool): whether the root mount was synthesized
            because no resource claimed ``/``.
    """
    prefixes = {"/dev", HISTORY_PREFIX}
    if implicit_root:
        prefixes.add("/")
    return prefixes
