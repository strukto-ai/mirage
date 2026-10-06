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

import re
from collections.abc import Iterable

from dulwich.errors import NotTreeError
from dulwich.objects import Commit, ObjectID, ShaFile, Tag, Tree
from dulwich.objectspec import parse_commit
from dulwich.refs import Ref
from dulwich.repo import BaseRepo

from mirage.bridge.sync import run_async_from_sync
from mirage.commands.cli.builtin.git.constants import DWIM_RULES, HEAD
from mirage.commands.cli.builtin.git.errors import (
    AmbiguousArgumentError,
    BadRevisionError,
    InvalidRevisionNameError,
    PathNotAtStageError,
    PathNotInIndexError,
    PathNotInRevisionError,
)
from mirage.commands.cli.builtin.git.index_file import read_index
from mirage.commands.cli.builtin.git.io import exists
from mirage.commands.cli.builtin.git.refs import TAG_PREFIX
from mirage.commands.cli.builtin.git.repo import Repo
from mirage.commands.cli.builtin.git.types import AncestryStep, PeelStep, RevOp
from mirage.utils.path import join_spec

ANCESTOR = "~"
PARENT = "^"
SUFFIXES = (ANCESTOR, PARENT)
# ``<rev>^{<type>}`` peels to a type; ``<rev>:<path>`` reads a tree.
PEEL_OPEN = "^{"
PEEL_CLOSE = "}"
PATH_MARK = ":"
COMMIT = "commit"
TREE = "tree"
TAG = "tag"
# Not a type any object reports: ``^{object}`` asks only that the name
# resolve to something, and hands back whatever that is.
OBJECT = "object"
STAGED = re.compile(r"[0-3]:")
# ``A..B`` hides A and walks B; a third dot walks both and hides only
# what they share. A leading caret hides one revision on its own.
RANGE = ".."
SYMMETRIC_DOT = "."
NEGATION = "^"
LEFT = 1
RIGHT = 2
STALE = 4


def split_operators(revision: str) -> tuple[str, tuple[RevOp, ...]]:
    """Split a revision into its base and the operators applied to it.

    git reads a revision left to right: every ``~n``, ``^n`` and
    ``^{<type>}`` applies to whatever the one before it produced, so
    ``HEAD^{commit}~1`` is the parent of HEAD and ``HEAD~1^{tree}`` is
    that parent's tree. Reading the peel as a trailing thing instead
    refused every chain that did not end in one, and reading ``^{`` as
    an ancestry step is worse than refusing: ``^`` with no digits means
    "first parent", so ``HEAD^{tree}`` would answer with HEAD's parent
    without a word. Splitting on the first ``~`` or ``^`` is safe
    because git forbids both in a ref name, so neither can belong to
    the base. Pinned against git 2.50.1.

    Args:
        revision (str): revision as the user spelled it.

    Returns:
        tuple[str, tuple[RevOp, ...]]: the base, HEAD when the revision
        is all operators, and the operators in the order they apply.

    Raises:
        AmbiguousArgumentError: when the rest holds anything but
            operators.
    """
    index = next(
        (i for i, ch in enumerate(revision) if ch in SUFFIXES),
        len(revision),
    )
    base, rest = revision[:index], revision[index:]
    ops: list[RevOp] = []
    position = 0
    while position < len(rest):
        kind = rest[position]
        # Only ``~`` and ``^`` open an operator, and reading anything
        # else as one is silent rather than loud: every other character
        # counted as another first-parent hop, so ``HEAD^x`` resolved to
        # ``HEAD^^`` and the caller was handed a commit it never named.
        # git refuses the whole expression instead, and refuses
        # ``main~٣`` with it, since the digits it counts are ASCII.
        if kind not in SUFFIXES:
            raise AmbiguousArgumentError(revision)
        if rest.startswith(PEEL_OPEN, position):
            close = rest.find(PEEL_CLOSE, position)
            if close < 0:
                raise AmbiguousArgumentError(revision)
            ops.append(PeelStep(rest[position + len(PEEL_OPEN) : close]))
            position = close + 1
            continue
        position += 1
        digits = ""
        while position < len(rest) and rest[position] in "0123456789":
            digits += rest[position]
            position += 1
        count = 1 if digits == "" else int(digits)
        ops.append(AncestryStep(first_parent=kind == ANCESTOR, count=count))
    return base or HEAD, tuple(ops)


def _step(
    repo: BaseRepo, commit: Commit, step: AncestryStep, revision: str
) -> Commit:
    """Apply one ancestry suffix to a commit.

    ``~n`` walks n generations along first parents; ``^n`` takes the
    n-th parent of this commit, and ``^0`` is the commit itself (git's
    way of spelling "the commit a tag points at").

    Args:
        repo (BaseRepo): repository to resolve parents against.
        commit (Commit): the commit the previous step produced.
        step (AncestryStep): the suffix to apply.
        revision (str): the whole revision, for error attribution.
    """
    if step.first_parent:
        for _ in range(step.count):
            if not commit.parents:
                raise AmbiguousArgumentError(revision)
            commit = _commit_at(repo, commit.parents[0], revision)
        return commit
    if step.count == 0:
        return commit
    if step.count > len(commit.parents):
        raise AmbiguousArgumentError(revision)
    return _commit_at(repo, commit.parents[step.count - 1], revision)


def _commit_at(repo: BaseRepo, sha: ObjectID, revision: str) -> Commit:
    """Load one commit by object id, or report the revision as unknown.

    Args:
        repo (BaseRepo): repository holding the object.
        sha (ObjectID): hex object id.
        revision (str): the whole revision, for error attribution.
    """
    try:
        obj = repo.object_store[sha]
    except KeyError as exc:
        raise AmbiguousArgumentError(revision) from exc
    if not isinstance(obj, Commit):
        raise AmbiguousArgumentError(revision)
    return obj


def resolve_commit(repo: BaseRepo, revision: str) -> Commit:
    """Resolve a revision to a commit, ancestry suffixes included.

    dulwich resolves refs, full ids and unambiguous short ids, but knows
    nothing about ``~`` and ``^``; those are applied here, on top of
    whatever its own parser returns.

    A ``^{}`` or ``^{commit}`` peel asks for exactly what this returns
    and is honoured; a peel naming any other type is a revision this
    caller cannot use, so it is refused rather than quietly stripped.

    Args:
        repo (BaseRepo): repository to resolve against.
        revision (str): revision as the user spelled it.
    """
    base, ops = split_operators(revision)
    try:
        commit = parse_commit(repo, base)
    except (KeyError, ValueError) as exc:
        raise AmbiguousArgumentError(revision) from exc
    note_ambiguity(repo, base)
    for op in ops:
        if isinstance(op, AncestryStep):
            commit = _step(repo, commit, op, revision)
            continue
        # A peel this caller can use is one that lands back on a
        # commit: ``^{}`` and ``^{commit}`` do, ``^{tree}`` does not,
        # and refusing the object rather than the spelling is what lets
        # a peel sit in the middle of a chain.
        found = _peeled(repo, commit, op.want, revision)
        if not isinstance(found, Commit):
            raise AmbiguousArgumentError(revision)
        commit = found
    return commit


def _range_ends(revision: str) -> tuple[str, str, bool] | None:
    """The two ends of ``A..B`` or ``A...B``, or None for one revision.

    Read the way git's handle_dotdot reads it: the first ``..`` splits
    the operand, a dot right after it makes the range symmetric, and an
    empty end is HEAD, so ``..side`` is ``HEAD..side``.

    Args:
        revision (str): the operand as the user spelled it.

    Returns:
        tuple[str, str, bool] | None: the left end, the right end and
        whether the range is symmetric.
    """
    at = revision.find(RANGE)
    if at < 0:
        return None
    right = revision[at + len(RANGE) :]
    symmetric = right.startswith(SYMMETRIC_DOT)
    if symmetric:
        right = right[len(SYMMETRIC_DOT) :]
    return revision[:at] or HEAD, right or HEAD, symmetric


def range_commits(
    repo: BaseRepo, revision: str
) -> tuple[Commit, Commit, bool] | None:
    """Both ends of a range operand, or None when it names one revision.

    A lone ``..`` is a path to git, and mirage limits nothing by path,
    so it is no range here and fails as the revision it is not.

    Args:
        repo (BaseRepo): repository to resolve against.
        revision (str): the operand as the user spelled it.

    Returns:
        tuple[Commit, Commit, bool] | None: the left end, the right end
        and whether the range is symmetric.

    Raises:
        AmbiguousArgumentError: an end does not resolve; the message
            names the whole operand, as git's does.
    """
    ends = None if revision == RANGE else _range_ends(revision)
    if ends is None:
        return None
    try:
        return (
            resolve_commit(repo, ends[0]),
            resolve_commit(repo, ends[1]),
            ends[2],
        )
    except AmbiguousArgumentError as exc:
        raise AmbiguousArgumentError(revision) from exc


def merge_bases(repo: BaseRepo, one: Commit, other: Commit) -> list[Commit]:
    """The common ancestors of two commits that nothing shared descends from.

    git's paint walk: each side paints what it reaches, newest first
    and first queued on a tie, and a commit wearing both colours is a
    base whose own ancestry goes stale. The walk ends once every queued
    commit is stale, and the bases come out in the order git lists them
    (pinned against ``git merge-base --all`` 2.50).

    Args:
        repo (BaseRepo): repository whose store holds the commits.
        one (Commit): one side.
        other (Commit): the other side.
    """
    paint = {one.id: LEFT}
    paint[other.id] = paint.get(other.id, 0) | RIGHT
    queue = [one] if one.id == other.id else [one, other]
    bases: list[Commit] = []
    while any(not paint[commit.id] & STALE for commit in queue):
        queue.sort(key=lambda commit: -commit.commit_time)
        commit = queue.pop(0)
        flags = paint[commit.id]
        if flags == LEFT | RIGHT:
            bases.append(commit)
            flags |= STALE
            paint[commit.id] = flags
        for parent_id in commit.parents:
            if paint.get(parent_id, 0) & flags == flags:
                continue
            paint[parent_id] = paint.get(parent_id, 0) | flags
            queue.append(_commit_at(repo, parent_id, parent_id.decode()))
    return bases


def split_revisions(
    repo: BaseRepo, revisions: tuple[str, ...]
) -> tuple[list[Commit], list[Commit]]:
    """The commits a walk starts from and the commits whose history it hides.

    ``A..B`` walks B and hides A, ``A...B`` walks both and hides their
    merge bases, and ``^A`` hides A. An end that does not resolve fails
    naming the whole range, and a negation that does not resolve is
    git's "bad revision", as is a negated range (pinned against git
    2.50).

    Args:
        repo (BaseRepo): repository to resolve against.
        revisions (tuple[str, ...]): the revision operands as spelled.

    Returns:
        tuple[list[Commit], list[Commit]]: the commits to walk from and
        the commits to hide.
    """
    shown: list[Commit] = []
    hidden: list[Commit] = []
    for revision in revisions:
        if revision.startswith(NEGATION):
            name = revision[len(NEGATION) :]
            if not name or RANGE in name:
                raise BadRevisionError(revision)
            try:
                hidden.append(resolve_commit(repo, name))
            except AmbiguousArgumentError as exc:
                raise BadRevisionError(revision) from exc
            continue
        ends = range_commits(repo, revision)
        if ends is None:
            shown.append(resolve_commit(repo, revision))
            continue
        left, right, symmetric = ends
        if symmetric:
            shown.extend((left, right))
            hidden.extend(merge_bases(repo, left, right))
        else:
            shown.append(right)
            hidden.append(left)
    return shown, hidden


def object_at(repo: BaseRepo, revision: str) -> ShaFile:
    """The object one id names, whatever its type.

    Only an id, full or abbreviated: a ref and an ancestry suffix are
    the caller's to try first, and this is what is left for the tree or
    blob id git also takes wherever an object is wanted. An
    abbreviation is expanded through the store rather than looked up,
    since a store answers only a whole id.

    Args:
        repo (BaseRepo): the opened repository.
        revision (str): the id as the user spelled it.

    Raises:
        KeyError: when no object carries that id.
    """
    wanted = revision.encode()
    try:
        return repo[ObjectID(wanted)]
    except KeyError:
        found = list(repo.object_store.iter_prefix(wanted))
        if len(found) != 1:
            raise
        return repo[found[0]]


def _object_by_id(repo: BaseRepo, sha: ObjectID, revision: str) -> ShaFile:
    """Load one object by id, or report the revision as unknown.

    Args:
        repo (BaseRepo): repository holding the object.
        sha (ObjectID): hex object id.
        revision (str): the whole revision, for error attribution.
    """
    try:
        return repo.object_store[sha]
    except KeyError as exc:
        raise AmbiguousArgumentError(revision) from exc


def unwrapped(repo: BaseRepo, obj: ShaFile, revision: str) -> ShaFile:
    """What an object stands for once every tag wrapper is off.

    An annotated tag can point at another one, so this is a walk rather
    than a single hop. Anything that is no tag is already what it
    stands for and comes back untouched.

    Every reading that wants a particular kind of object goes through
    this: a bare id names the tag itself, so a caller asking for a
    tree-ish or for the tree behind ``<rev>:<path>`` has one to take
    off, and git takes it off in both places.

    Args:
        repo (BaseRepo): the opened repository.
        obj (ShaFile): the object to unwrap.
        revision (str): the whole revision, for error attribution.
    """
    while isinstance(obj, Tag):
        obj = _object_by_id(repo, obj.object[1], revision)
    return obj


def _peeled(repo: BaseRepo, obj: ShaFile, want: str, revision: str) -> ShaFile:
    """Follow a ``^{<type>}`` peel from the object the stem named.

    A tag is unwrapped until the type asked for is reached, which for
    ``^{}`` and for every non-tag type means unwrapping it entirely.
    ``^{tag}`` is the one spelling that stops before the first hop, so
    ``v1^{tag}`` is the tag object itself rather than a refusal saying
    the commit behind it is no tag. ``^{tree}`` then takes a commit's
    tree, git's one implicit step; every other spelling has to already
    name the type it asks for, so ``HEAD^{blob}`` is refused rather
    than answered with something else.

    A lightweight tag is still refused by ``^{tag}``: the name resolves
    straight to a commit, so there is no tag object to stop at and the
    type check below is what says so.

    Args:
        repo (BaseRepo): the opened repository.
        obj (ShaFile): the object the stem resolved to.
        want (str): the type word inside the braces, empty for ``^{}``.
        revision (str): the whole revision, for error attribution.
    """
    if want == OBJECT:
        # An existence check, not a type. Every object reports a
        # concrete type name, so comparing one against ``object``
        # refuses every expression that spells it; gitrevisions(7) has
        # it return the named object and nothing else, which for an
        # annotated tag is the tag rather than the commit behind it.
        return obj
    if want != TAG:
        obj = unwrapped(repo, obj, revision)
    if want == "":
        return obj
    if want == TREE and isinstance(obj, Commit):
        obj = _object_by_id(repo, obj.tree, revision)
    if obj.type_name.decode() != want:
        raise AmbiguousArgumentError(revision)
    return obj


def _at_path(repo: BaseRepo, rev: str, path: str, revision: str) -> ShaFile:
    """The object a ``<rev>:<path>`` names inside a tree.

    Args:
        repo (BaseRepo): the opened repository.
        rev (str): the revision before the colon.
        path (str): the path after it, repository-relative.
        revision (str): the whole revision, for error attribution.

    Raises:
        InvalidRevisionNameError: the revision names nothing.
        PathNotInRevisionError: its tree holds no such path.
    """
    try:
        named = resolve_object(repo, rev)
    except AmbiguousArgumentError as exc:
        raise InvalidRevisionNameError(rev) from exc
    # A tag is no tree and holds no path, so it comes off first: the
    # rev half is a tree-ish, and ``<tag-id>:a.txt`` reads the blob
    # through it exactly as ``v1:a.txt`` does.
    holder = unwrapped(repo, named, revision)
    if isinstance(holder, Commit):
        holder = _object_by_id(repo, holder.tree, revision)
    if not isinstance(holder, Tree):
        raise AmbiguousArgumentError(revision)
    try:
        _mode, sha = holder.lookup_path(
            repo.object_store.__getitem__, path.encode()
        )
    except (KeyError, NotTreeError, ValueError) as exc:
        raise PathNotInRevisionError(path, rev, _on_disk(repo, path)) from exc
    return _object_by_id(repo, sha, revision)


def _on_disk(repo: BaseRepo, path: str) -> bool:
    """Whether a repository-relative path is there in the working tree; a
    path through a file is not.

    Args:
        repo (BaseRepo): the opened repository.
        path (str): the path, repository-relative.
    """
    if not path or not isinstance(repo, Repo):
        return False
    where = join_spec(repo.location.worktree, path)
    try:
        return run_async_from_sync(exists(repo.dispatch, where), repo.loop)
    except NotADirectoryError:
        return False


def _in_index(repo: BaseRepo, spec: str) -> ShaFile:
    """The object ``:<path>`` or ``:<n>:<path>`` names in the index.

    The staged entry at stage 0, or at the merge stage given. A path the
    index holds at another stage, or not at all, is refused in git's
    words (pinned against git 2.50.1).

    Args:
        repo (BaseRepo): the opened repository.
        spec (str): what follows the leading colon.

    Raises:
        PathNotAtStageError: the index holds it at another stage.
        PathNotInIndexError: the index does not hold it.
    """
    staged = STAGED.match(spec)
    stage = int(spec[0]) if staged else 0
    path = spec[staged.end() :] if staged else spec
    if not isinstance(repo, Repo):
        raise PathNotInIndexError(path, False)
    state = run_async_from_sync(
        read_index(repo.dispatch, repo.location.gitdir), repo.loop
    )
    key = path.encode()
    stages = [state.entries.get(key)]
    conflicted = state.conflicts.get(key)
    stages.extend(
        [conflicted.ancestor, conflicted.this, conflicted.other]
        if conflicted is not None
        else [None, None, None]
    )
    found = stages[stage]
    if found is not None:
        return _object_by_id(repo, ObjectID(found.sha), spec)
    held = next(
        (at for at, entry in enumerate(stages) if entry is not None), -1
    )
    if held != -1:
        raise PathNotAtStageError(path, stage, held)
    raise PathNotInIndexError(path, _on_disk(repo, path))


def refs_named(known: Iterable[str], name: str) -> list[str]:
    """Every ref git's rev-parse rules find for a name, in rule order.

    More than one is a name git calls ambiguous, and the first is the
    one it reads.

    Args:
        known (Iterable[str]): every ref name.
        name (str): the name as typed.
    """
    names = set(known)
    return [
        ref
        for ref in dict.fromkeys(
            rule.replace("{}", name) for rule in DWIM_RULES
        )
        if ref in names
    ]


def note_ambiguity(repo: BaseRepo, name: str) -> None:
    """Put git's ``refname is ambiguous`` warning on the repository's
    list when two refs answer to a name, as git does each time it reads
    one.

    Args:
        repo (BaseRepo): the opened repository.
        name (str): the name as typed.
    """
    if not isinstance(repo, Repo) or repo.ambiguous is None:
        return
    known = (ref.decode(errors="replace") for ref in repo.refs.allkeys())
    if len(refs_named(known, name)) > 1:
        repo.ambiguous.append(f"warning: refname '{name}' is ambiguous.\n")


def _named_object(repo: BaseRepo, revision: str) -> ShaFile:
    """The object a name or id stands for, an annotated tag unpeeled.

    A name two refs answer to reads as the first, with git's warning
    that it is ambiguous (pinned against git 2.47.3).

    Args:
        repo (BaseRepo): the opened repository.
        revision (str): the name or id as typed.
    """
    known = [ref.decode(errors="replace") for ref in repo.refs.allkeys()]
    named = refs_named(known, revision)
    if named:
        try:
            sha = repo.refs[Ref(named[0].encode())]
        except KeyError as exc:
            raise AmbiguousArgumentError(revision) from exc
        note_ambiguity(repo, revision)
        return _object_by_id(repo, ObjectID(sha), revision)
    try:
        return object_at(repo, revision)
    except (KeyError, ValueError) as exc:
        raise AmbiguousArgumentError(revision) from exc


def tag_object(repo: BaseRepo, stem: str) -> Tag | None:
    """The tag object a name or id denotes, None when it names no tag.

    Read before the stem is resolved, and only for ``^{tag}``: every
    other peel type sits at or below the commit, so unwrapping an
    annotated tag on the way is git's own rule and costs nothing, while
    ``^{tag}`` is the one spelling that has to stop above it. Resolving
    the stem the ordinary way cannot serve it, because the commit-ish
    reading peels the tag before anything else sees it.

    Both spellings a tag answers to are tried, the ref and a raw id,
    and anything that is not a tag object reads as no tag: a lightweight
    tag names a commit directly, which is why git refuses ``^{tag}`` on
    one.

    Args:
        repo (BaseRepo): the opened repository.
        stem (str): the revision before the peel.
    """
    ref = Ref(f"{TAG_PREFIX}{stem}".encode())
    try:
        found = (
            repo.object_store[ObjectID(repo.refs[ref])]
            if ref in repo.refs.allkeys()
            else object_at(repo, stem)
        )
    except (KeyError, ValueError):
        return None
    return found if isinstance(found, Tag) else None


def resolve_object(repo: BaseRepo, revision: str) -> ShaFile:
    """The object a revision names, whatever type it turns out to be.

    The whole grammar a caller that wants an object rather than a
    commit has to read: ``HEAD:a.txt`` is the blob at a path,
    ``HEAD^{tree}`` is a commit's tree, ``v1^{}`` is what a tag points
    at, and a bare id of any type is itself. A commit-ish is tried
    first because that is what the operand is normally spelled with,
    and it is the only reading that understands ancestry.

    Args:
        repo (BaseRepo): repository to resolve against.
        revision (str): revision as the user spelled it.
    """
    if revision.startswith(PATH_MARK):
        return _in_index(repo, revision[len(PATH_MARK) :])
    if PATH_MARK in revision:
        rev, _, path = revision.partition(PATH_MARK)
        return _at_path(repo, rev, path, revision)
    base, ops = split_operators(revision)
    if not ops:
        # A name or id stands for exactly the object it names, so an
        # annotated tag is the tag rather than the commit behind it: git
        # does not peel one until a caller asks for a commit-ish, and
        # ``git rev-parse v1`` prints the tag's id.
        return _named_object(repo, revision)
    # Every operator but ``^{tag}`` and ``^{object}`` unwraps a tag,
    # which is git's own rule and costs nothing here.
    obj = resolve_object(repo, base)
    for op in ops:
        if isinstance(op, PeelStep):
            obj = _peeled(repo, obj, op.want, revision)
            continue
        commit = unwrapped(repo, obj, revision)
        if not isinstance(commit, Commit):
            raise AmbiguousArgumentError(revision)
        obj = _step(repo, commit, op, revision)
    return obj
