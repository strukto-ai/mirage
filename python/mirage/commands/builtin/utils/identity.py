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

from dataclasses import dataclass

from mirage.commands.config import CommandOpts
from mirage.view.types import SessionView

# What an owner or group column prints when nothing names one: no uid or
# gid on the entry and no profile.
UNKNOWN_NAME = "-"


@dataclass(frozen=True, slots=True)
class Identity:
    """Who a session is: its profile, the one name POSIX renders as both
    owner and group.

    The profile is the permission set the session acts with, so it is
    the user ``whoami`` prints and the group ``id`` names. A backend
    that reports a uid or gid on an entry (disk, or a ``chown`` held in
    the attr overlay) wins over it, so ``ls -l``, ``stat %U %G`` and
    ``find -printf %u %g`` all agree on one rule.

    Args:
        profile (str | None): the session's profile name, None for an
            unrestricted session.
    """

    profile: str | None = None


def identity_from(session_view: SessionView | None) -> Identity:
    """The identity the session plane describes.

    Args:
        session_view (SessionView | None): the session plane, which
            carries the profile; None outside a workspace.
    """
    return Identity(
        profile=session_view.profile() if session_view is not None else None,
    )


def identity_of(opts: CommandOpts) -> Identity:
    """The identity a command invocation runs as, read off its opts.

    Args:
        opts (CommandOpts): the dispatcher context of the invocation.
    """
    return identity_from(opts.session_view)


def owner_name(uid: int | str | None, identity: Identity | None) -> str:
    """The owner column: the entry's own uid, else the session's profile.

    Args:
        uid (int | str | None): what the backend or overlay reported.
        identity (Identity | None): who the session is; None outside a
            workspace.
    """
    if uid is not None:
        return str(uid)
    if identity is not None and identity.profile is not None:
        return identity.profile
    return UNKNOWN_NAME


def group_name(gid: int | str | None, identity: Identity | None) -> str:
    """The group column: the entry's own gid, else the session's profile.

    Args:
        gid (int | str | None): what the backend or overlay reported.
        identity (Identity | None): who the session is; None outside a
            workspace.
    """
    if gid is not None:
        return str(gid)
    if identity is not None and identity.profile is not None:
        return identity.profile
    return UNKNOWN_NAME
