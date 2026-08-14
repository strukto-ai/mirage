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

from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from mirage.types import MountMode, weaker_mode
from mirage.utils.hidden import path_hidden

if TYPE_CHECKING:
    from mirage.workspace.session.manager import SessionManager
    from mirage.workspace.session.session import Session


@dataclass(frozen=True, slots=True)
class SessionBinding:
    """The session bound to one async context, and whose it is.

    Args:
        session (Session | None): the live session.
        owner (SessionManager | None): the session manager the session
            belongs to, which is one per workspace. None when the
            binder did not name one.
    """
    session: "Session | None"
    owner: "SessionManager | None"


_current_session: ContextVar[SessionBinding | None] = ContextVar(
    "mirage_current_session",
    default=None,
)


def set_current_session(session: "Session | None",
                        owner: "SessionManager | None" = None) -> Token[Any]:
    """Bind ``session`` to the current async context.

    Args:
        session (Session | None): the session to bind.
        owner (SessionManager | None): the manager the session belongs
            to. None keeps the owner already bound, so a nested bind
            inside a line (a background job's fork) stays attributed to
            the workspace running it.
    """
    if owner is None:
        current = _current_session.get()
        owner = current.owner if current is not None else None
    return _current_session.set(SessionBinding(session=session, owner=owner))


def reset_current_session(token: Token[Any]) -> None:
    """Restore the previous session binding."""
    _current_session.reset(token)


def get_current_session() -> "Session | None":
    """Return the session bound to the current async context, if any."""
    binding = _current_session.get()
    return binding.session if binding is not None else None


def get_current_session_for(owner: "SessionManager") -> "Session | None":
    """Return the bound session only when ``owner`` published it.

    A session carries one workspace's cwd, env and mount grants, so a
    second workspace re-entered mid-line must resolve its own session
    rather than adopt this one.

    Args:
        owner (SessionManager): the asking workspace's session manager.
    """
    binding = _current_session.get()
    if binding is None or binding.owner is not owner:
        return None
    return binding.session


def _norm_prefix(mount_prefix: str) -> str:
    stripped = mount_prefix.strip("/")
    return "/" + stripped if stripped else "/"


def _session_mode(mount_prefix: str) -> "MountMode | None":
    """The current session's mode cap for this mount.

    Returns ``MountMode.EXEC`` (no narrowing) when no session is bound or
    the session is unrestricted, ``None`` when the session has mount modes but
    none for this mount.

    Args:
        mount_prefix (str): the mount's prefix, e.g. ``/s3``.
    """
    sess = get_current_session()
    if sess is None or sess.mount_modes is None:
        return MountMode.EXEC
    return sess.mount_modes.get(_norm_prefix(mount_prefix))


def hidden_paths_active() -> bool:
    """Whether the current session hides any paths at all.

    For a summarizing fast path (du -s asks the backend for one total)
    that must not be trusted when hidden leaves could be inside it.

    Args:
        None
    """
    sess = get_current_session()
    return sess is not None and sess.hidden_paths is not None


def path_allowed(virtual: str) -> bool:
    """Whether the current session's hidden-paths spec leaves this
    path visible.

    The path twin of ``mount_allowed``: enumeration surfaces filter
    names through it and the doors answer ENOENT (EACCES for creates)
    when it says no, so hiding reads as nonexistence, never as a
    denial that leaks the name. True when no session is bound or the
    session hides nothing.

    Args:
        virtual (str): absolute virtual path.
    """
    sess = get_current_session()
    if sess is None or sess.hidden_paths is None:
        return True
    return not path_hidden(sess.hidden_paths, virtual)


def mount_allowed(mount_prefix: str) -> bool:
    """Whether the current session may touch this mount at all.

    The non-raising twin of ``assert_mount_allowed``, for enumeration:
    structure merges and fan-outs filter names through it, so a scoped
    session never learns that an ungranted mount exists. True when no
    session is bound or the session is unrestricted.

    Args:
        mount_prefix (str): the mount's prefix, e.g. ``/s3``.
    """
    return _session_mode(mount_prefix) is not None


def assert_mount_allowed(mount_prefix: str) -> None:
    """Raise PermissionError if the current session may not touch this mount.

    No-op when no session is bound or the session is unrestricted
    (``mount_modes is None``). The session's ``mount_modes`` is
    expected to already include any infrastructure prefixes (observer,
    ``/dev``) added at session-creation time. A user-defined root mount
    is governed like any other: a session must be granted ``/`` to
    touch it.

    Args:
        mount_prefix (str): the mount's prefix, e.g. ``/s3`` or ``/`` for the
            cache root.

    Raises:
        PermissionError: the mount lies outside the session's mounts.
    """
    if _session_mode(mount_prefix) is not None:
        return
    sess = get_current_session()
    sid = sess.session_id if sess is not None else "<none>"
    raise PermissionError(f"session {sid!r} not allowed to "
                          f"access mount {_norm_prefix(mount_prefix)!r}")


def effective_mount_mode(mount_prefix: str,
                         mount_mode: MountMode) -> MountMode:
    """The mount mode after narrowing by the current session's cap.

    The mount's own mode is the ceiling; a session's mode can only weaken
    it (a READ mount stays read-only whatever the session says). A mount
    absent from the modes map narrows to READ here; visibility denial
    is ``assert_mount_allowed``'s job at the dispatch entry points.

    Args:
        mount_prefix (str): the mount's prefix, e.g. ``/s3``.
        mount_mode (MountMode): the mount's configured mode.
    """
    cap = _session_mode(mount_prefix)
    if cap is None:
        return MountMode.READ
    return weaker_mode(mount_mode, cap)
