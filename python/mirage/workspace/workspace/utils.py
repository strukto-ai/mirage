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

from mirage.execution.process.types import Process
from mirage.workspace.session import SessionState
from mirage.workspace.session.session import vars_from_env


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
    back to the persistent session. Without overrides the persistent
    session is used as is.

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
    return session.fork(**overrides)


def process_tree(records: list[Process], pid: int) -> set[int]:
    """The pid and those of every process it started, followed through
    each record's parent.

    Args:
        records (list[Process]): the processes to look through.
        pid (int): the process at the root.
    """
    children: dict[int, list[int]] = {}
    for record in records:
        if record.parent is not None:
            children.setdefault(record.parent, []).append(record.pid)
    tree: set[int] = set()
    todo = [pid]
    while todo:
        current = todo.pop()
        if current not in tree:
            tree.add(current)
            todo.extend(children.get(current, []))
    return tree
