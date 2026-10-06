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

import posixpath
import time

from dulwich.refs import DictRefsContainer

from mirage.commands.cli.builtin.git.commit import identity
from mirage.commands.cli.builtin.git.constants import HEAD
from mirage.commands.cli.builtin.git.errors import (
    BadRefNameUpdateError,
    DeleteHeadError,
    EmptyUpdateMessageError,
    GitError,
    HeadOutsideRefsError,
    InvalidSymbolicTargetError,
    NoSuchRefError,
    NotASymbolicRefError,
    NotSymbolicDeleteError,
    NoWorkspaceError,
    SymbolicRefLockError,
    SymbolicRefReadOnlyError,
    UsageError,
)
from mirage.commands.cli.builtin.git.io import (
    remove_file,
    write_file,
)
from mirage.commands.cli.builtin.git.ref_fields import shorten_ref
from mirage.commands.cli.builtin.git.reflog import ZERO, append, entry, logged
from mirage.commands.cli.builtin.git.refs import (
    SYMREF_PREFIX,
    blocking_ref,
    delete_ref,
    load_refs,
    raw_ref,
    resolve_symbolic,
    safe_ref_name,
    whole_ref_name,
)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    fatal,
    verb_usage,
)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec

REFS_PREFIX = "refs/"
LOGS_DIR = "logs"


def _switched(fl: FlagView, name: str, default: bool) -> bool:
    """The last of an option and its ``--no-`` twin on the line.

    Args:
        fl (FlagView): the line's flags.
        name (str): the option's kwarg name.
        default (bool): the answer when neither is there.
    """
    value = default
    for key, _ in fl.occurrences(name, f"no_{name}"):
        value = key == name
    return value


def owner_of(location: RepoLocation, name: str) -> PathSpec:
    """The git directory a ref lives in.

    HEAD and the one-level names belong to the checkout, every ``refs/``
    name to the repository its worktrees share.

    Args:
        location (RepoLocation): the discovered repository.
        name (str): the full ref name.
    """
    if name == HEAD or not name.startswith(REFS_PREFIX):
        return location.gitdir
    return location.commondir


def symbolic_ref_read_only(
    inv: CLIInvocation[None], location: RepoLocation | None
) -> GitError:
    """symbolic-ref's refusal by a read-only mount, at the lock on the
    ref it names.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
        location (RepoLocation | None): the repository it opened.
    """
    name = inv.texts[0] if inv.texts else ""
    root = ".git" if location is None else owner_of(location, name).virtual
    return SymbolicRefReadOnlyError(name, posixpath.join(root, name))


async def object_of(
    dispatch: DispatchFn, gitdir: PathSpec, table: DictRefsContainer, name: str
) -> bytes | None:
    """The object id a ref ends at, through any symbolic hops.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        gitdir (PathSpec): this checkout's git directory.
        table (DictRefsContainer): every ref, as load_refs reads them.
        name (str): the full ref name.
    """
    end = await resolve_symbolic(dispatch, gitdir, table, name, True)
    if end is None:
        return None
    raw = await raw_ref(dispatch, gitdir, table, end.name)
    if raw is None or raw.startswith(SYMREF_PREFIX):
        return None
    return raw.encode()


async def set_symbolic(
    dispatch: DispatchFn,
    location: RepoLocation,
    table: DictRefsContainer,
    name: str,
    target: str,
    who: bytes,
    message: str,
) -> None:
    """Point a ref at another one, symbolically, and log the move.

    The log line runs from what the ref resolved to before to what its
    new target resolves to, and is skipped while that target names
    nothing yet, as git skips it for a dangling symbolic ref. An empty
    message leaves the line without one.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
        table (DictRefsContainer): every ref, as load_refs reads them.
        name (str): the ref to write.
        target (str): the ref it points at.
        who (bytes): the identity the log line records.
        message (str): the ``-m`` reason, empty for none.

    Raises:
        BadRefNameUpdateError: a name git's ref transaction refuses.
        SymbolicRefLockError: a name another ref's path stands on.
    """
    if not safe_ref_name(name):
        raise BadRefNameUpdateError(name)
    held = blocking_ref(set(table.allkeys()), name)
    if held is not None:
        raise SymbolicRefLockError(name, held)
    gitdir = location.gitdir
    before = await object_of(dispatch, gitdir, table, name)
    owner = owner_of(location, name)
    await write_file(
        dispatch,
        owner.join(name),
        f"{SYMREF_PREFIX}{target}\n".encode(),
    )
    after = await object_of(dispatch, gitdir, table, target)
    log = owner.join(LOGS_DIR, name)
    if after is None or not await logged(dispatch, location, name, log):
        return
    await append(
        dispatch,
        owner,
        f"{LOGS_DIR}/{name}",
        entry(before or ZERO, after, who, int(time.time()), message),
    )


async def symbolic_ref(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """``git symbolic-ref``: read, change or delete a symbolic ref.

    One operand prints the ref it points at, followed to the end of the
    chain unless ``--no-recurse``, shortened by ``--short``; a ref that
    is not symbolic is a fatal, or a bare exit 1 under ``-q``. Two
    operands point the first at the second, which HEAD may only do
    inside ``refs/``. ``-d`` removes a symbolic ref and its log, never
    HEAD, and ``-q`` does not quiet its refusal. Pinned against git
    2.47.3.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
    """
    fl = FlagView(inv.flags)
    doors = inv.doors or CLIDoors()
    dispatch = doors.dispatch
    try:
        if dispatch is None:
            raise NoWorkspaceError()
        check_switches(inv, inv.texts)
        _, location = await opened(fl, doors)
        message = fl.as_str("m")
        if message == "":
            raise EmptyUpdateMessageError()
        quiet = _switched(fl, "quiet", False)
        gitdir = location.gitdir
        table = await load_refs(dispatch, gitdir, location.commondir)
        names = tuple(inv.texts)
        name = names[0] if names else ""
        if _switched(fl, "delete", False):
            if len(names) != 1:
                raise UsageError("", verb_usage(inv))
            found = await resolve_symbolic(
                dispatch, gitdir, table, name, False
            )
            if found is None:
                raise NoSuchRefError(name)
            if not found.symbolic:
                raise NotSymbolicDeleteError(name)
            if name == HEAD:
                raise DeleteHeadError()
            owner = owner_of(location, name)
            await delete_ref(dispatch, owner, name)
            await remove_file(dispatch, owner.join(LOGS_DIR, name))
            return None, IOResult()
        if len(names) == 2:
            target = names[1]
            if name == HEAD and not target.startswith(REFS_PREFIX):
                raise HeadOutsideRefsError()
            if not whole_ref_name(target):
                raise InvalidSymbolicTargetError(name, target)
            who = identity(fl, doors.session_view)
            await set_symbolic(
                dispatch, location, table, name, target, who, message or ""
            )
            return None, IOResult()
        if len(names) != 1:
            raise UsageError("", verb_usage(inv))
        found = await resolve_symbolic(
            dispatch, gitdir, table, name, _switched(fl, "recurse", True)
        )
        if found is None:
            raise NoSuchRefError(name)
        if not found.symbolic:
            if quiet:
                return None, IOResult(exit_code=1)
            raise NotASymbolicRefError(name)
        shown = found.name
        if _switched(fl, "short", False):
            known = frozenset(
                ref.decode(errors="replace") for ref in table.allkeys()
            )
            shown = shorten_ref(shown, known, strict=False)
        return f"{shown}\n".encode(), IOResult()
    except GitError as exc:
        return fatal(exc)
