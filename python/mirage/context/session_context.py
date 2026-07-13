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
from typing import TYPE_CHECKING

from mirage.types import MountMode, weaker_mode

if TYPE_CHECKING:
    from mirage.workspace.session.session import Session

_current_session: ContextVar["Session | None"] = ContextVar(
    "mirage_current_session",
    default=None,
)


def set_current_session(session: "Session | None") -> Token:
    """Bind ``session`` to the current async context."""
    return _current_session.set(session)


def reset_current_session(token: Token) -> None:
    """Restore the previous session binding."""
    _current_session.reset(token)


def get_current_session() -> "Session | None":
    """Return the session bound to the current async context, if any."""
    return _current_session.get()


def _norm_prefix(mount_prefix: str) -> str:
    stripped = mount_prefix.strip("/")
    return "/" + stripped if stripped else "/"


def _session_grant(mount_prefix: str) -> "MountMode | None":
    """The current session's grant for this mount.

    Returns ``MountMode.EXEC`` (no narrowing) when no session is bound or
    the session is unrestricted, ``None`` when the session has grants but
    none for this mount.

    Args:
        mount_prefix (str): the mount's prefix, e.g. ``/s3``.
    """
    sess = _current_session.get()
    if sess is None or sess.mount_grants is None:
        return MountMode.EXEC
    return sess.mount_grants.get(_norm_prefix(mount_prefix))


def assert_mount_allowed(mount_prefix: str) -> None:
    """Raise PermissionError if the current session may not touch this mount.

    No-op when no session is bound or the session is unrestricted
    (``mount_grants is None``). The session's ``mount_grants`` is
    expected to already include any infrastructure prefixes (observer,
    ``/dev``) added at session-creation time. A user-defined root mount
    is governed like any other: a session must be granted ``/`` to
    touch it.

    Args:
        mount_prefix (str): the mount's prefix, e.g. ``/s3`` or ``/`` for the
            cache root.

    Raises:
        PermissionError: the mount lies outside the session's grants.
    """
    if _session_grant(mount_prefix) is not None:
        return
    sess = _current_session.get()
    raise PermissionError(f"session {sess.session_id!r} not allowed to "
                          f"access mount {_norm_prefix(mount_prefix)!r}")


def effective_mount_mode(mount_prefix: str,
                         mount_mode: MountMode) -> MountMode:
    """The mount mode after narrowing by the current session's grant.

    The mount's own mode is the ceiling; a session grant can only weaken
    it (a READ mount stays read-only whatever the grant says). A mount
    absent from the grants map narrows to READ here; visibility denial
    is ``assert_mount_allowed``'s job at the dispatch entry points.

    Args:
        mount_prefix (str): the mount's prefix, e.g. ``/s3``.
        mount_mode (MountMode): the mount's configured mode.
    """
    grant = _session_grant(mount_prefix)
    if grant is None:
        return MountMode.READ
    return weaker_mode(mount_mode, grant)
