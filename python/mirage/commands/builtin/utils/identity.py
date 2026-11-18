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

from mirage.commands.config import Context
from mirage.core.generic.types import Ids
from mirage.utils.stat_view import id_number
from mirage.view.types import SessionView

# What a column prints for a fact nothing reports, such as another
# session's owner in ps.
UNKNOWN_NAME = "-"

# What stat prints for an id the user database holds no name for.
UNKNOWN_ID_NAME = "UNKNOWN"

ROOT_ID = 0
# The first id Debian's adduser hands a person, which a profile's user
# holds.
USER_ID = 1000
# The id the kernel maps an unknown owner to (overflowuid).
NOBODY_ID = 65534

# The home bash's `~` names for a uid the user database does not hold.
NO_HOME = "/"
# Where Debian's adduser puts a person's home.
HOME_BASE = "/home"


@dataclass(frozen=True, slots=True)
class Account:
    """One user the session's user database holds, as an
    ``/etc/passwd`` row names it.

    Args:
        name (str): the login name.
        uid (int): the user id.
        group (str): the name of the user's group.
        gid (int): the group id.
        home (str): the home directory.
    """

    name: str
    uid: int
    group: str
    gid: int
    home: str


ROOT = Account("root", ROOT_ID, "root", ROOT_ID, "/root")
NOBODY = Account("nobody", NOBODY_ID, "nogroup", NOBODY_ID, "/nonexistent")


@dataclass(frozen=True, slots=True)
class Identity:
    """Who a session is, read off its profile, as Linux reads a process's
    user off its uid.

    A session with no profile is root, uid 0: nothing restricts it, as
    nothing restricts uid 0. A named profile is a user of that name
    with uid and gid 1000, the first an installer hands a person, unless
    the name is one the database already holds (``root``, ``nobody``).
    A profile document passed without a name is uid 1000 with no entry
    in the database, so ``whoami`` cannot name it, as Linux cannot name
    a uid missing from ``/etc/passwd``. A backend that reports an
    owner on an entry (disk, a machine, or a ``chown`` the attr overlay
    holds) wins over the session's, so ``ls -l``, ``stat`` and ``find``
    agree on one rule.

    Args:
        profile (str | None): the session's profile name; None for a
            session with no profile, empty for a document passed
            without a name.
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


def identity_of(ctx: Context) -> Identity:
    """The identity a command invocation runs as, read off its ctx.

    Args:
        ctx (Context): the dispatcher context of the invocation.
    """
    return identity_from(ctx.session)


def own_account(identity: Identity | None) -> Account | None:
    """The session's own row in the user database, None for a profile
    document passed without a name.

    Args:
        identity (Identity | None): who the session is; None outside a
            workspace, which is root.
    """
    profile = None if identity is None else identity.profile
    if profile is None:
        return ROOT
    if profile == "":
        return None
    for held in (ROOT, NOBODY):
        if held.name == profile:
            return held
    return Account(
        profile, USER_ID, profile, USER_ID, f"{HOME_BASE}/{profile}"
    )


def accounts(identity: Identity | None) -> tuple[Account, ...]:
    """The session's user database: root, nobody and the session's own
    user.

    Args:
        identity (Identity | None): who the session is.
    """
    own = own_account(identity)
    if own is None or own in (ROOT, NOBODY):
        return (ROOT, NOBODY)
    return (ROOT, NOBODY, own)


def session_uid(identity: Identity | None) -> int:
    """The uid the session runs as.

    Args:
        identity (Identity | None): who the session is.
    """
    own = own_account(identity)
    return USER_ID if own is None else own.uid


def session_gid(identity: Identity | None) -> int:
    """The gid the session runs as.

    Args:
        identity (Identity | None): who the session is.
    """
    own = own_account(identity)
    return USER_ID if own is None else own.gid


def home_of(identity: Identity | None) -> str:
    """The home directory bash's ``~`` names when ``HOME`` is unset.

    Args:
        identity (Identity | None): who the session is.
    """
    own = own_account(identity)
    return NO_HOME if own is None else own.home


def user_homes(identity: Identity | None) -> dict[str, str]:
    """Each user's home, which bash's ``~name`` names.

    Args:
        identity (Identity | None): who the session is.
    """
    return {account.name: account.home for account in accounts(identity)}


def user_named(identity: Identity | None, name: str) -> Account | None:
    """The user a name names, as ``groups`` looks one up: by name only.

    Args:
        identity (Identity | None): who the session is.
        name (str): the operand as typed.
    """
    for account in accounts(identity):
        if account.name == name:
            return account
    return None


def find_user(identity: Identity | None, text: str) -> Account | None:
    """The user a name or a number names, as ``id`` and ``chown`` look
    one up: by name first, then by uid when the text is a number.

    Args:
        identity (Identity | None): who the session is.
        text (str): the operand as typed.
    """
    named = user_named(identity, text)
    if named is not None:
        return named
    number = id_number(text)
    return None if number is None else user_with_id(identity, number)


def user_with_id(identity: Identity | None, uid: int) -> Account | None:
    """The user a uid belongs to, None for a uid the database lacks.

    Args:
        identity (Identity | None): who the session is.
        uid (int): the id.
    """
    for account in accounts(identity):
        if account.uid == uid:
            return account
    return None


def group_id_named(identity: Identity | None, name: str) -> int | None:
    """The gid a group name names, None for a name the database lacks.

    Args:
        identity (Identity | None): who the session is.
        name (str): the group name.
    """
    for account in accounts(identity):
        if account.group == name:
            return account.gid
    return None


def group_with_id(identity: Identity | None, gid: int) -> str | None:
    """The name of the group a gid is, None for a gid the database
    lacks.

    Args:
        identity (Identity | None): who the session is.
        gid (int): the id.
    """
    for account in accounts(identity):
        if account.gid == gid:
            return account.group
    return None


def owner_id(uid: int | str | None, identity: Identity | None) -> int | str:
    """The owner's uid: the entry's own, else the session's. A name a
    backend reports (a machine names its owners) maps through the
    database, and stays a name where the database lacks it.

    Args:
        uid (int | str | None): what the backend or overlay reported.
        identity (Identity | None): who the session is.
    """
    if uid is None:
        return session_uid(identity)
    if isinstance(uid, int):
        return uid
    number = id_number(uid)
    if number is not None:
        return number
    found = user_named(identity, uid)
    return uid if found is None else found.uid


def group_id(gid: int | str | None, identity: Identity | None) -> int | str:
    """The group's gid, read as :func:`owner_id` reads the owner's.

    Args:
        gid (int | str | None): what the backend or overlay reported.
        identity (Identity | None): who the session is.
    """
    if gid is None:
        return session_gid(identity)
    if isinstance(gid, int):
        return gid
    number = id_number(gid)
    if number is not None:
        return number
    found = group_id_named(identity, gid)
    return gid if found is None else found


def owner_name(uid: int | str | None, identity: Identity | None) -> str | None:
    """The owner's name, None for a uid the database holds no name for.

    Args:
        uid (int | str | None): what the backend or overlay reported.
        identity (Identity | None): who the session is.
    """
    number = owner_id(uid, identity)
    if isinstance(number, str):
        return number
    found = user_with_id(identity, number)
    return None if found is None else found.name


def group_name(gid: int | str | None, identity: Identity | None) -> str | None:
    """The group's name, None for a gid the database holds no name for.

    Args:
        gid (int | str | None): what the backend or overlay reported.
        identity (Identity | None): who the session is.
    """
    number = group_id(gid, identity)
    if isinstance(number, str):
        return number
    return group_with_id(identity, number)


def owner_label(uid: int | str | None, identity: Identity | None) -> str:
    """The owner column ``ls -l`` prints: the name, else the number.

    Args:
        uid (int | str | None): what the backend or overlay reported.
        identity (Identity | None): who the session is.
    """
    return owner_name(uid, identity) or str(owner_id(uid, identity))


def group_label(gid: int | str | None, identity: Identity | None) -> str:
    """The group column ``ls -l`` prints: the name, else the number.

    Args:
        gid (int | str | None): what the backend or overlay reported.
        identity (Identity | None): who the session is.
    """
    return group_name(gid, identity) or str(group_id(gid, identity))


def find_ids(identity: Identity | None) -> Ids:
    """The user database as ``find`` reads it.

    Args:
        identity (Identity | None): who the session is.
    """
    held = accounts(identity)
    return Ids(
        users={account.name: account.uid for account in held},
        groups={account.group: account.gid for account in held},
        uid=session_uid(identity),
        gid=session_gid(identity),
    )
