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

from mirage.accessor.base import Accessor
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
from mirage.commands.cli.builtin.git.reflog import (
    LOGS_DIR,
    ZERO,
    append,
    entry,
    logged,
)
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
from mirage.commands.cli.builtin.git.repo import Repo
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    fatal,
    verb_usage,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

REFS_PREFIX = "refs/"


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
    texts: list[str], ctx: Context, location: RepoLocation | None
) -> GitError:
    """symbolic-ref's refusal by a read-only mount, at the lock on the
    ref it names.

    Args:
        texts (list[str]): the line's operands.
        ctx (Context): the line's context.
        location (RepoLocation | None): the repository it opened.
    """
    name = texts[0] if texts else ""
    root = ".git" if location is None else owner_of(location, name).virtual
    return SymbolicRefReadOnlyError(name, posixpath.join(root, name))


async def object_of(
    repo: Repo, table: DictRefsContainer, name: str
) -> bytes | None:
    """The object id a ref ends at, through any symbolic hops.

    Args:
        repo (Repo): the opened repository.
        table (DictRefsContainer): every ref, as load_refs reads them.
        name (str): the full ref name.
    """
    vfs, gitdir = repo.dispatch, repo.location.gitdir
    end = await resolve_symbolic(vfs, gitdir, table, name, True)
    if end is None:
        return None
    raw = await raw_ref(vfs, gitdir, table, end.name)
    if raw is None or raw.startswith(SYMREF_PREFIX):
        return None
    return raw.encode()


async def set_symbolic(
    repo: Repo,
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
        repo (Repo): the opened repository.
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
    vfs, location = repo.dispatch, repo.location
    before = await object_of(repo, table, name)
    owner = owner_of(location, name)
    await write_file(
        vfs,
        owner.join(name),
        f"{SYMREF_PREFIX}{target}\n".encode(),
    )
    after = await object_of(repo, table, target)
    log = owner.join(LOGS_DIR, name)
    if after is None or not await logged(vfs, location, name, log):
        return
    await append(
        vfs,
        owner,
        f"{LOGS_DIR}/{name}",
        entry(before or ZERO, after, who, int(time.time()), message),
    )


async def symbolic_ref(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
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
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the operands.
        ctx (Context): the line's context.
    """
    fl = FlagView(ctx.flags)
    vfs = ctx.vfs
    try:
        if vfs is None:
            raise NoWorkspaceError()
        check_switches(ctx, texts)
        repo, location = await opened(ctx, fl)
        message = fl.as_str("m")
        if message == "":
            raise EmptyUpdateMessageError()
        quiet = _switched(fl, "quiet", False)
        gitdir = location.gitdir
        table = await load_refs(vfs, gitdir, location.commondir)
        names = tuple(texts)
        name = names[0] if names else ""
        if _switched(fl, "delete", False):
            if len(names) != 1:
                raise UsageError("", verb_usage(ctx))
            found = await resolve_symbolic(vfs, gitdir, table, name, False)
            if found is None:
                raise NoSuchRefError(name)
            if not found.symbolic:
                raise NotSymbolicDeleteError(name)
            if name == HEAD:
                raise DeleteHeadError()
            owner = owner_of(location, name)
            await delete_ref(vfs, owner, name)
            await remove_file(vfs, owner.join(LOGS_DIR, name))
            return None, IOResult()
        if len(names) == 2:
            target = names[1]
            if name == HEAD and not target.startswith(REFS_PREFIX):
                raise HeadOutsideRefsError()
            if not whole_ref_name(target):
                raise InvalidSymbolicTargetError(name, target)
            who = identity(fl, ctx.session)
            await set_symbolic(repo, table, name, target, who, message or "")
            return None, IOResult()
        if len(names) != 1:
            raise UsageError("", verb_usage(ctx))
        found = await resolve_symbolic(
            vfs, gitdir, table, name, _switched(fl, "recurse", True)
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
