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
from dataclasses import dataclass

from dulwich.refs import Ref

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.branch import (
    refuse_ambiguous,
    remote_branch,
    track_mode,
)
from mirage.commands.cli.builtin.git.checkout import move_head
from mirage.commands.cli.builtin.git.constants import HEAD
from mirage.commands.cli.builtin.git.errors import (
    BranchExistsError,
    BranchExpectedError,
    DetachWithCreateError,
    GitError,
    InvalidBranchNameError,
    InvalidReferenceError,
    MissingBranchArgumentError,
    NoWorkspaceError,
    OneReferenceError,
    RefLockError,
    RefReadOnlyError,
)
from mirage.commands.cli.builtin.git.index_file import (
    read_index,
    refuse_unresolved,
)
from mirage.commands.cli.builtin.git.refs import (
    BRANCH_PREFIX,
    REMOTE_PREFIX,
    TAG_PREFIX,
    blocking_ref,
    read_head,
    set_head,
    valid_branch_name,
)
from mirage.commands.cli.builtin.git.revparse import (
    COMMIT,
    TAG,
    note_ambiguity,
    resolve_commit,
)
from mirage.commands.cli.builtin.git.session import index_locked, opened
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    fatal,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

REMOTE_BRANCH = "remote branch"


@dataclass(frozen=True, slots=True)
class SwitchFlags:
    """The parsed shape of a ``git switch`` invocation.

    Args:
        create (str | None): ``-c``, the branch to create and switch to.
        detach (bool): ``--detach``, leave HEAD on the commit itself.
    """

    create: str | None
    detach: bool


def parse_flags(fl: FlagView) -> SwitchFlags:
    """Read the raw switch flag kwargs into a frozen struct.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    return SwitchFlags(create=fl.as_str("create"), detach=fl.as_bool("detach"))


def expected_kind(known: set[Ref], name: str) -> str:
    """What a non-branch operand named, for the refusal that says so.

    git tells a tag and a remote-tracking branch apart from a bare
    commit in the same sentence, so the refusal can say which one the
    caller reached for.

    Args:
        known (set[Ref]): every ref the repository publishes.
        name (str): the operand as the user spelled it.
    """
    if Ref(f"{TAG_PREFIX}{name}".encode()) in known:
        return TAG
    if Ref(f"{REMOTE_PREFIX}{name}".encode()) in known:
        return REMOTE_BRANCH
    return COMMIT


async def switch_branch(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Switch to a branch, creating it under ``-c``.

    The same move ``checkout`` makes, with a narrower grammar: only a
    branch is accepted, so a commit, tag or remote-tracking name is
    refused unless ``--detach`` says that a detached HEAD is what was
    meant. That is the whole reason git split the verb off, and it
    holds here for the same reason: a detached HEAD is the state an
    agent loses commits in.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the operands.
        ctx (Context): the line's context; git reads its repository
            through ``ctx.vfs``.
    """
    vfs = ctx.vfs
    fl = FlagView(ctx.flags)
    try:
        if vfs is None:
            raise NoWorkspaceError()
        check_switches(ctx, texts)
        flags = parse_flags(fl)
        creating = flags.create is not None
        if creating and flags.detach:
            raise DetachWithCreateError()
        if len(texts) > 1:
            raise OneReferenceError()
        # A detach takes HEAD when nothing is named, which is git's
        # own default; only an attaching switch needs a branch to name.
        if not creating and not texts and not flags.detach:
            raise MissingBranchArgumentError()
        repo, location = await opened(ctx, fl, work_tree=True)
        mode = await track_mode(repo)
        head = await read_head(vfs, location.gitdir)
        known = repo.refs.allkeys()
        if flags.create is not None:
            target = flags.create
            ref = Ref(f"{BRANCH_PREFIX}{target}".encode())
            start = texts[0] if texts else None
            # Before the first commit there is nothing for HEAD to
            # resolve to, and git makes the branch anyway: the line
            # only repoints symbolic HEAD, writing neither the ref nor
            # a reflog line, because a branch with no commit is a name
            # and nothing else. A start point is a different line and
            # stays unresolvable (``fatal: invalid reference: main``),
            # so this reads the shape of the line rather than probing
            # HEAD. Pinned against git 2.50.1.
            unborn = (
                start is None
                and head.ref is not None
                and Ref(head.ref.encode()) not in known
            )
            if start is not None:
                try:
                    commit = resolve_commit(repo, start)
                except GitError as exc:
                    raise InvalidReferenceError(start) from exc
                await refuse_ambiguous(repo, start, False)
            # After a start point that was named and before HEAD is
            # read or anything is written, which is git's own order, and
            # before it asks whether the branch exists, so a
            # refs/heads/HEAD already there is still refused as a name.
            # A ref is a path below .git, so an unchecked name reaches
            # write_ref as one: -c ../../config would land on the
            # repository's own configuration rather than on a branch.
            if not valid_branch_name(target):
                raise InvalidBranchNameError(target)
            if ref in known:
                raise BranchExistsError(target)
            if start is None and not unborn:
                try:
                    commit = resolve_commit(repo, HEAD)
                except GitError as exc:
                    raise InvalidReferenceError(HEAD) from exc
            # And before the working tree moves: git takes the ref lock
            # first, so a name whose path another ref holds refuses with
            # nothing checked out.
            held = blocking_ref(known, ref.decode())
            if held is not None:
                raise RefLockError(ref.decode(), held)
            attached = True
            if unborn:
                await set_head(vfs, location.gitdir, ref.decode())
                return yield_bytes(b""), IOResult(
                    stderr=b""
                    if fl.as_bool("quiet")
                    else f"Switched to a new branch '{target}'\n".encode()
                )
        else:
            start = None
            target = texts[0] if texts else HEAD
            ref = Ref(f"{BRANCH_PREFIX}{target}".encode())
            # The ref has to exist, not just be the name HEAD carries.
            # A fresh repository's HEAD names a branch that has never
            # been written, and reading the name alone answered
            # ``Already on 'main'`` at exit 0 for a branch with no
            # commit to be on. git resolves it first and dies, which is
            # what leaves ``switch -c`` as the only line an unborn HEAD
            # accepts. Pinned against git 2.50.1.
            if not flags.detach and target == head.branch and ref in known:
                note_ambiguity(repo, target)
                # Moving nothing is not the same as having nothing to
                # check: git dies on an unresolved index here too, so
                # the shortcut reads it before it answers. Every ref
                # check above comes first, which is git's own order.
                refuse_unresolved(await read_index(vfs, location.gitdir))
                return None, IOResult(
                    stderr=b""
                    if fl.as_bool("quiet")
                    else f"Already on '{target}'\n".encode()
                )
            # git's --guess, on by default: no such branch here but one
            # remote has it, so the switch creates it tracking that one.
            start = (
                None
                if flags.detach or ref in known
                else remote_branch(repo, target)
            )
            creating = start is not None
            # A branch of that name wins over every other reading, as
            # git's switch reads it, though the name is still reported
            # as ambiguous.
            local = not flags.detach and start is None and ref in known
            if local:
                note_ambiguity(repo, target)
            try:
                commit = resolve_commit(
                    repo, ref.decode() if local else (start or target)
                )
            except GitError as exc:
                raise InvalidReferenceError(target) from exc
            attached = creating or (not flags.detach and ref in known)
            if not flags.detach and not attached:
                raise BranchExpectedError(expected_kind(known, target), target)
        return await move_head(
            vfs,
            repo,
            location,
            head,
            commit,
            target,
            ref if attached else None,
            creating,
            start,
            mode,
            False,
            fl.as_bool("quiet"),
        )
    except GitError as exc:
        return fatal(exc)


def switch_read_only(
    texts: list[str], ctx: Context, location: RepoLocation | None
) -> GitError:
    """switch's refusal by a read-only mount: the new branch's ref under
    a ``-c`` with no start point, whose lock git takes first, and the
    index's otherwise.

    Args:
        texts (list[str]): the line's operands.
        ctx (Context): the line's context.
        location (RepoLocation | None): the repository it opened.
    """
    name = FlagView(ctx.flags, ctx.spec).as_str("create")
    if name is None or texts:
        return index_locked(texts, ctx, location)
    ref = f"{BRANCH_PREFIX}{name}"
    root = location.commondir.virtual if location is not None else ".git"
    return RefReadOnlyError(ref, posixpath.join(root, ref))
