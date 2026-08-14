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
from mirage.workspace.session.state import env_get


def home_dir(session: Session) -> str | None:
    """Return the session home directory used for ``~`` expansion.

    Args:
        session: The shell session.

    Returns:
        ``$HOME`` from the session env, or ``None`` when unset/empty,
        matching GNU bash (no implicit home; ``cd`` errors, ``~`` and
        ``$HOME`` do not expand). Read through the session door, not
        the raw env: this is HOME's own resolution channel ($HOME,
        tilde expansion, bare ``cd``), so a hidden HOME must read as
        unset here too.
    """
    return env_get(session, "HOME") or None


def logical_cwd(session: Session) -> str:
    """Return the cwd as last spelled, falling back to the physical one.

    bash keeps two names for the working directory: the physical one the
    kernel resolves to, and the logical one you typed to get there. Only
    ``pwd``/``pwd -L`` and ``cd``'s own ``..`` read the logical name;
    everything that resolves an operand uses ``session.cwd``.

    This is the shell's own record, deliberately not ``$PWD``: that is an
    ordinary variable the user can assign, and bash does not read it back
    when deciding where ``cd ..`` goes. Clobbering ``$PWD`` and running
    ``cd ..`` from /data/lk still lands on /data.

    Args:
        session: The shell session.

    Returns:
        ``session.logical_cwd`` when a symlink was walked through, else
        ``session.cwd``.
    """
    return session.logical_cwd or session.cwd


def set_cwd(session: Session, cwd: str) -> None:
    """Point the session at ``cwd`` without recording a ``cd``.

    For the callers that move a session from outside the shell: a
    snapshot restore, the session-store handoff, and the ``workspace.cwd``
    setter. No typed spelling exists behind such a move, so the logical
    name is dropped rather than left describing wherever the session used
    to be, and ``$OLDPWD`` is untouched because no ``cd`` ran. ``$PWD``
    does follow, since it names where the session is.

    Args:
        session: The shell session to mutate.
        cwd: The absolute physical path to point at.
    """
    session.cwd = cwd
    session.logical_cwd = None
    session.env["PWD"] = cwd


def change_dir(session: Session,
               new_cwd: str,
               logical: str | None = None) -> None:
    """Move the session to ``new_cwd`` and record the previous cwd.

    ``$OLDPWD`` is a straight copy of ``$PWD`` as it stands right now --
    not of the shell's own record. The two agree unless the user assigned
    to ``$PWD``, and bash carries the assignment through: after
    ``PWD=/clobber; cd /data`` a following ``cd -`` tries /clobber and
    fails, and after ``unset PWD; cd /data`` ``$OLDPWD`` is empty.
    ``$PWD`` is then re-stated from the shell's record, so ``cd`` always
    repairs whatever was done to it.

    bash never re-validates the logical name: deleting the symlink it was
    spelled through leaves ``pwd`` still printing it. Nothing here checks
    it either.

    Args:
        session: The shell session to mutate.
        new_cwd: The absolute physical path to switch to.
        logical: The spelling to report when it differs from ``new_cwd``.
            None keeps the pair collapsed, which is what ``-P`` wants.
    """
    session.env["OLDPWD"] = session.env.get("PWD", "")
    session.cwd = new_cwd
    session.logical_cwd = logical if logical and logical != new_cwd else None
    session.env["PWD"] = logical_cwd(session)
