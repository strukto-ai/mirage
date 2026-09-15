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

from dulwich.errors import NotTreeError
from dulwich.objects import Commit, ObjectID, ShaFile, Tag, Tree
from dulwich.objectspec import parse_commit
from dulwich.refs import Ref
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.constants import HEAD
from mirage.commands.cli.builtin.git.errors import AmbiguousArgumentError
from mirage.commands.cli.builtin.git.refs import TAG_PREFIX
from mirage.commands.cli.builtin.git.types import AncestryStep, PeelStep, RevOp

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
            ops.append(PeelStep(rest[position + len(PEEL_OPEN):close]))
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


def _step(repo: BaseRepo, commit: Commit, step: AncestryStep,
          revision: str) -> Commit:
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
        rev (str): the revision before the colon, HEAD when empty.
        path (str): the path after it, repository-relative.
        revision (str): the whole revision, for error attribution.
    """
    # A tag is no tree and holds no path, so it comes off first: the
    # rev half is a tree-ish, and ``<tag-id>:a.txt`` reads the blob
    # through it exactly as ``v1:a.txt`` does.
    holder = unwrapped(repo, resolve_object(repo, rev), revision)
    if isinstance(holder, Commit):
        holder = _object_by_id(repo, holder.tree, revision)
    if not isinstance(holder, Tree):
        raise AmbiguousArgumentError(revision)
    try:
        _mode, sha = holder.lookup_path(repo.object_store.__getitem__,
                                        path.encode())
    except (KeyError, NotTreeError, ValueError) as exc:
        raise AmbiguousArgumentError(revision) from exc
    return _object_by_id(repo, sha, revision)


def _tag_object(repo: BaseRepo, stem: str) -> Tag | None:
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
        found = (repo.object_store[ObjectID(repo.refs[ref])]
                 if ref in repo.refs.allkeys() else object_at(repo, stem))
    except (KeyError, ValueError):
        return None
    return found if isinstance(found, Tag) else None


def _tag_at_id(repo: BaseRepo, revision: str) -> Tag | None:
    """The tag object a bare id names, None when the id names no tag.

    A tag is the one type whose bare-id reading differs from the
    commit-ish one below, which is why this is scoped to it rather than
    put in front of every resolution: every other type either is the
    commit that reading returns or is not commit-ish at all, and
    already falls through to the id.

    A tag *name* is deliberately not read here. git splits the two, and
    the split is observable: ``git tag nested v1`` records the tag
    object while ``git restore --source=v1`` reads the tree behind it.

    Args:
        repo (BaseRepo): the opened repository.
        revision (str): the revision as the user spelled it.
    """
    try:
        found = object_at(repo, revision)
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
    if PATH_MARK in revision:
        rev, _, path = revision.partition(PATH_MARK)
        return _at_path(repo, rev or HEAD, path, revision)
    base, ops = split_operators(revision)
    if not ops:
        # A bare id names that exact object, and for an annotated tag
        # that is the tag rather than the commit behind it: the
        # commit-ish reading below is a peel, and git does not peel an
        # id. ``git tag nested <tag-id>`` records the tag, which is the
        # nested tag git warns about rather than quietly flattens.
        held = _tag_at_id(repo, revision)
        if held is not None:
            return held
        try:
            return resolve_commit(repo, revision)
        except AmbiguousArgumentError:
            # Not a commit-ish. A raw id is read as itself before the
            # revision is called unresolved, and the type is kept,
            # since it is what a caller records.
            try:
                return object_at(repo, revision)
            except (KeyError, ValueError) as exc:
                raise AmbiguousArgumentError(revision) from exc
    # The base is resolved without peeling an annotated tag, because
    # ``^{tag}`` and ``^{object}`` are the two spellings that have to
    # stop above it; every other operator unwraps the tag itself, which
    # is git's own rule and costs nothing here.
    held = _tag_object(repo, base)
    obj = held if held is not None else resolve_object(repo, base)
    for op in ops:
        if isinstance(op, PeelStep):
            obj = _peeled(repo, obj, op.want, revision)
            continue
        commit = unwrapped(repo, obj, revision)
        if not isinstance(commit, Commit):
            raise AmbiguousArgumentError(revision)
        obj = _step(repo, commit, op, revision)
    return obj
