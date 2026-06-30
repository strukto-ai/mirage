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

from mirage.workspace.session.session import Session


def home_dir(session: Session) -> str | None:
    """Return the session home directory used for ``~`` expansion.

    Args:
        session: The shell session.

    Returns:
        ``$HOME`` from the session env, or ``None`` when unset/empty,
        matching GNU bash (no implicit home; ``cd`` errors, ``~`` and
        ``$HOME`` do not expand).
    """
    return session.env.get("HOME") or None


def change_dir(session: Session, new_cwd: str) -> None:
    """Move the session to ``new_cwd`` and record the previous cwd.

    Sets ``$OLDPWD`` to the current cwd before switching, mirroring the
    bash ``cd`` builtin. ``$PWD`` is resolved dynamically from
    ``session.cwd`` at lookup time, so it is not stored here.

    Args:
        session: The shell session to mutate.
        new_cwd: The absolute path to switch to.
    """
    session.env["OLDPWD"] = session.cwd
    session.cwd = new_cwd
