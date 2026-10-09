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

from mirage.commands.cli.builtin.git.branch import (
    refuse_ambiguous,
    remote_branch,
    set_up_tracking,
    track_mode,
)
from mirage.commands.cli.builtin.git.checkout import (
    move_head,
    previous_position,
    tracking_report,
)
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
from mirage.commands.cli.builtin.git.format import short, subject
from mirage.commands.cli.builtin.git.index_file import (
    read_index,
    refuse_unresolved,
)
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.refs import (
    BRANCH_PREFIX,
    TAG_PREFIX,
    blocking_ref,
    read_head,
    set_head,
    valid_ref_name,
)
from mirage.commands.cli.builtin.git.revparse import (
    note_ambiguity,
    resolve_commit,
)
from mirage.commands.cli.builtin.git.session import index_locked, opened
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    fatal,
    links_of,
    mounts_of,
)
from mirage.commands.cli.types import CLIInvocation, CLIView
from mirage.commands.spec.flag_view import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult

REMOTES_PREFIX = "refs/remotes/"
COMMIT = "commit"
TAG = "tag"
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
    if Ref(f"{REMOTES_PREFIX}{name}".encode()) in known:
        return REMOTE_BRANCH
    return COMMIT


async def switch(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """Switch to a branch, creating it under ``-c``.

    The same move ``checkout`` makes, with a narrower grammar: only a
    branch is accepted, so a commit, tag or remote-tracking name is
    refused unless ``--detach`` says that a detached HEAD is what was
    meant. That is the whole reason git split the verb off, and it
    holds here for the same reason: a detached HEAD is the state an
    agent loses commits in.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
            git declares no config_model; the planes it reads
            (data through ``dispatch``, names through ``ns``) ride
            ``inv.view``.
    """
    view = inv.view or CLIView()
    dispatch = view.dispatch
    stat_path = view.stat_path
    texts = inv.texts
    fl = FlagView(inv.flags)
    try:
        if dispatch is None or stat_path is None:
            raise NoWorkspaceError()
        check_switches(inv, texts)
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
        repo, location = await opened(fl, view, work_tree=True)
        mode = await track_mode(dispatch, location)
        head = await read_head(dispatch, location.gitdir)
        known = repo.refs.allkeys()
        if flags.create is not None:
            target = flags.create
            ref = Ref(f"{BRANCH_PREFIX}{target}".encode())
            if ref in known:
                raise BranchExistsError(target)
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
            if not unborn:
                try:
                    commit = resolve_commit(repo, start or HEAD)
                except GitError as exc:
                    raise InvalidReferenceError(start or HEAD) from exc
                if start is not None:
                    await refuse_ambiguous(
                        dispatch, location, repo, start, False
                    )
            # After the start point and before anything is written,
            # which is git's own order. A ref is a path below .git, so
            # an unchecked name reaches write_ref as one: -c
            # ../../config would land on the repository's own
            # configuration rather than on a branch.
            if not valid_ref_name(target):
                raise InvalidBranchNameError(target)
            # And before the working tree moves: git takes the ref lock
            # first, so a name whose path another ref holds refuses with
            # nothing checked out.
            held = blocking_ref(known, ref.decode())
            if held is not None:
                raise RefLockError(ref.decode(), held)
            attached = True
            if unborn:
                await set_head(dispatch, location.gitdir, ref.decode())
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
                refuse_unresolved(await read_index(dispatch, location.gitdir))
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
        moved = await move_head(
            dispatch,
            stat_path,
            links_of(view),
            mounts_of(view),
            repo,
            location,
            head,
            commit,
            target,
            ref if attached else None,
            creating,
            start or HEAD,
            creating and start is None,
        )
        tracking, warning = (
            await set_up_tracking(
                dispatch, repo, location, target, start, mode, head
            )
            if creating
            else ("", "")
        )
    except GitError as exc:
        return fatal(exc)
    carried = "".join(
        f"{letter}\t{path}\n" for path, letter in sorted(moved.carried.items())
    )
    carried += tracking
    # Above everything the move says about itself, which is where git
    # puts it: what could not be removed is a fact about the working
    # tree rather than about where HEAD went.
    note = moved.warnings + previous_position(repo, head) + warning
    if attached:
        verb = "Switched to a new branch" if creating else "Switched to branch"
        note += f"{verb} '{target}'\n"
        if not creating:
            carried += await tracking_report(dispatch, location, target)
    else:
        note += (
            f"HEAD is now at {short(commit.id, abbrev_for(repo))} "
            f"{subject(commit)}\n"
        )
    if fl.as_bool("quiet"):
        return None, IOResult(stderr=(moved.warnings + warning).encode())
    return yield_bytes(carried.encode()), IOResult(stderr=note.encode())


def switch_read_only(
    inv: CLIInvocation[None], location: RepoLocation | None
) -> GitError:
    """switch's refusal by a read-only mount: the new branch's ref under
    ``-c``, whose lock git takes first, and the index's otherwise.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
        location (RepoLocation | None): the repository it opened.
    """
    name = FlagView(inv.flags).as_str("create")
    if name is None:
        return index_locked(inv, location)
    ref = f"{BRANCH_PREFIX}{name}"
    root = location.commondir.virtual if location is not None else ".git"
    return RefReadOnlyError(ref, posixpath.join(root, ref))
