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
from collections.abc import Iterator, Mapping
from typing import TypeVar

from dulwich.objects import (
    Blob,
    Commit,
    ObjectID,
    ShaFile,
    Tag,
    Tree,
    TreeEntry,
)
from dulwich.repo import BaseRepo

from mirage.bridge.sync import run_async_from_sync
from mirage.commands.cli.builtin.git.constants import TREE
from mirage.commands.cli.builtin.git.index_file import read_index
from mirage.commands.cli.builtin.git.pathspec import visible_path
from mirage.commands.cli.builtin.git.repo import Repo
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.context.session_context import current_caller
from mirage.workspace.files import reader_of

T = TypeVar("T")
Entry = tuple[int, bytes]

# What a session is shown of a repository's history. A hide or a path
# rule names a place in the working tree, and git keeps every version
# of what stood there in its object store, which no file call reaches:
# so git asks the same two questions of the place an object stands at.
# A hidden place is one the history never had, and content at a place a
# rule keeps from the command is refused as the file is.


def guarded(repo: BaseRepo) -> bool:
    """Whether a hide or a rule in force could cover anything in the
    repository's working tree for the running command; when nothing can,
    every object is shown as stored and nothing is looked up.

    Args:
        repo (BaseRepo): the opened repository.
    """
    if not isinstance(repo, Repo) or repo.location.vfs is None:
        return False
    if repo.guarded is None:
        worktree = repo.location.worktree.virtual
        gate = current_caller().gate
        repo.guarded = reader_of(repo.location.vfs).hides_under(worktree) or (
            gate is not None and gate.scopes(worktree)
        )
    return repo.guarded


def check_rules(location: RepoLocation, relative: str) -> None:
    """Refuse a place as the dispatcher refuses its file: a rule in force
    for the running command raises ``PolicyDenied`` naming it.

    Args:
        location (RepoLocation): the discovered repository.
        relative (str): the repository-relative place.
    """
    gate = current_caller().gate
    if gate is not None and location.vfs is not None:
        gate.check(location.worktree.join(relative).virtual)


def permitted(location: RepoLocation, relative: str) -> bool:
    """Whether no rule in force refuses a place for the running command,
    asked without refusing it.

    Args:
        location (RepoLocation): the discovered repository.
        relative (str): the repository-relative place.
    """
    gate = current_caller().gate
    if gate is None or location.vfs is None:
        return True
    return gate.refusal(location.worktree.join(relative).virtual) is None


def placed(
    repo: BaseRepo, obj: T, relative: str, revision: str | None = None
) -> T:
    """An object a revision found at a place, which the session may be
    shown there: noted, so a tree prints what that place holds, and a
    blob's content refused where a rule keeps the place from the
    command. A rule guards content, not names, so a tree is listed.

    The caller has already refused a hidden place in its own words.

    Args:
        repo (BaseRepo): the opened repository.
        obj (T): the object found.
        relative (str): the repository-relative place.
        revision (str | None): the operand that named it, whose place
            this is whatever other place holds the same object.
    """
    if isinstance(repo, Repo) and isinstance(obj, ShaFile):
        if isinstance(obj, Blob):
            check_rules(repo.location, relative)
        repo.places.setdefault(obj.id, relative)
        if revision is not None:
            repo.named[revision] = relative
    return obj


def rooted(repo: BaseRepo, tree: bytes, revision: str | None = None) -> None:
    """Note a commit's tree, which stands at the repository's root.

    Args:
        repo (BaseRepo): the opened repository.
        tree (bytes): the root tree's id.
        revision (str | None): the operand that named it.
    """
    if isinstance(repo, Repo):
        repo.places.setdefault(tree, "")
        if revision is not None:
            repo.named[revision] = ""


def located(repo: BaseRepo, obj: ShaFile) -> ShaFile | None:
    """An object named by id, if the session may be shown it: one
    reachable at a place it sees and no rule keeps from the command.

    A commit and a tag carry no place and are always shown. A tree or a
    blob is looked for where the history and the index hold it, so an id
    an agent computed for content it guessed answers exactly as an id
    nothing holds. A blob held only where a rule keeps it raises that
    rule's ``PolicyDenied``.

    Args:
        repo (BaseRepo): the opened repository.
        obj (ShaFile): the object the id names.
    """
    if not guarded(repo) or isinstance(obj, (Commit, Tag)):
        return obj
    assert isinstance(repo, Repo)
    if obj.id in repo.places:
        return obj
    place = _find(repo, obj.id, isinstance(obj, Blob))
    if place is None:
        return None
    repo.places[obj.id] = place
    return obj


def visible_object(repo: BaseRepo, oid: bytes) -> bool:
    """Whether an id names an object the session may be shown: one the
    store holds, which ``located`` finds wherever it stands.

    Args:
        repo (BaseRepo): the opened repository.
        oid (bytes): the hex object id.
    """
    if ObjectID(oid) not in repo.object_store:
        return False
    if not guarded(repo):
        return True
    return located(repo, repo.object_store[ObjectID(oid)]) is not None


def place_of(repo: BaseRepo, oid: bytes) -> str:
    """Where this command found an object, for a tree whose entries are
    shown relative to it; the root when nothing narrows what is shown.

    Args:
        repo (BaseRepo): the opened repository.
        oid (bytes): the object's id.
    """
    if not isinstance(repo, Repo):
        return ""
    found = repo.places.get(oid)
    if found is None and guarded(repo):
        found = _find(repo, oid, False)
    return found or ""


def place_named(repo: BaseRepo, name: str, oid: bytes) -> str:
    """Where the object an operand names stands for that operand: the
    place its own path gave it (``HEAD:b`` is ``b`` even where ``HEAD:a``
    holds the same tree), else where this command found it.

    Args:
        repo (BaseRepo): the opened repository.
        name (str): the operand as typed.
        oid (bytes): the object's id.
    """
    if isinstance(repo, Repo) and name in repo.named:
        return repo.named[name]
    return place_of(repo, oid)


def shown_items(
    repo: BaseRepo, tree: Tree, base: str | None = None
) -> Iterator[TreeEntry]:
    """A tree's entries the session sees, at the place it was found.

    Args:
        repo (BaseRepo): the opened repository.
        tree (Tree): the tree to list.
        base (str | None): the place it stands at, None for where this
            command found it.
    """
    if not guarded(repo):
        yield from tree.iteritems()
        return
    assert isinstance(repo, Repo)
    where = place_of(repo, tree.id) if base is None else base
    for entry in tree.iteritems():
        name = entry.path.decode("utf-8", "surrogateescape")
        if visible_path(repo.location, posixpath.join(where, name)):
            yield entry


def shown_raw(repo: BaseRepo, obj: ShaFile, base: str | None = None) -> bytes:
    """An object's stored bytes as the session is shown them: a tree's
    re-encoded with only the entries it sees, so neither the bytes nor
    their count name a hidden one.

    Args:
        repo (BaseRepo): the opened repository.
        obj (ShaFile): the object.
        base (str | None): a tree's place, None for where this command
            found it.
    """
    if not isinstance(obj, Tree) or not guarded(repo):
        return obj.as_raw_string()
    kept = Tree()
    for entry in shown_items(repo, obj, base):
        kept.add(entry.path, entry.mode, entry.sha)
    return kept.as_raw_string()


def shown_entries(
    repo: BaseRepo, entries: Mapping[bytes, Entry], base: str = ""
) -> dict[bytes, Entry]:
    """A tree's leaves the session sees, keyed relative to ``base``.

    What a diff, a log or a search reads its sides from, so a hidden
    path is no change, no match and no count, as if never committed. A
    leaf at a place a rule keeps from the command stays listed, a rule
    guarding content rather than names, and its blob is noted so
    ``readable`` refuses to read it there.

    Args:
        repo (BaseRepo): the opened repository.
        entries (Mapping[bytes, Entry]): leaves keyed by Git name.
        base (str): the place the tree stands at.
    """
    if not guarded(repo):
        return dict(entries)
    assert isinstance(repo, Repo)
    location = repo.location
    shown: dict[bytes, Entry] = {}
    for path, (mode, sha) in entries.items():
        relative = posixpath.join(
            base, path.decode("utf-8", "surrogateescape")
        )
        if not visible_path(location, relative):
            continue
        shown[path] = (mode, sha)
        if permitted(location, relative):
            repo.free.add(sha)
        else:
            repo.sealed.setdefault(sha, relative)
    return shown


def readable(repo: BaseRepo, sha: bytes) -> None:
    """Refuse a blob's content where this command found it only at a
    place a rule keeps from it: the same bytes anywhere it may read are
    no secret, so those read.

    Args:
        repo (BaseRepo): the opened repository.
        sha (bytes): the blob's id.

    Raises:
        PolicyDenied: the rule's refusal, naming the place.
    """
    if not isinstance(repo, Repo) or sha in repo.free:
        return
    place = repo.sealed.get(sha)
    if place is not None:
        check_rules(repo.location, place)


def _find(repo: Repo, oid: bytes, content: bool) -> str | None:
    """The first place the index or the history holds an object at that
    the session sees and, for content, no rule keeps from the command.

    Every lookup a command makes shares one walk (``_sightings``),
    resumed where the last stopped and remembered as it goes, so a
    batch naming the same or many ids reads the history once. Content
    held only where rules refuse it is judged at the first such place,
    which raises that rule's ``PolicyDenied``.

    Args:
        repo (Repo): the opened repository.
        oid (bytes): the object's id.
        content (bool): whether it is a blob, whose bytes rules guard.
    """
    location = repo.location

    def usable(place: str) -> bool:
        return not content or permitted(location, place)

    for place in repo.seen.get(oid, ()):
        if usable(place):
            return place
    if repo.sightings is None:
        repo.sightings = _sightings(repo)
    for found, place in repo.sightings:
        repo.seen.setdefault(found, []).append(place)
        if found == oid and usable(place):
            return place
    held = repo.seen.get(oid)
    if not held:
        return None
    check_rules(location, held[0])
    return held[0]


def _sightings(repo: Repo) -> Iterator[tuple[bytes, str]]:
    """Every object the index and the history hold, each with a place
    the session sees, in the order a lookup wants them: the index first,
    then each commit any ref reaches. A subtree is read once per place,
    however many commits share it, and a hidden place is never descended
    into: what stands under it is hidden too. An object only a ref names
    directly stands at no place and is never sighted.

    Args:
        repo (Repo): the opened repository.
    """
    location = repo.location
    state = run_async_from_sync(
        read_index(repo.dispatch, location.gitdir), repo.loop
    )
    staged = [(name, entry.sha) for name, entry in state.entries.items()]
    for name, conflict in state.conflicts.items():
        staged.extend(
            (name, side.sha)
            for side in (conflict.ancestor, conflict.this, conflict.other)
            if side is not None
        )
    for name, sha in staged:
        relative = name.decode("utf-8", "surrogateescape")
        if relative and visible_path(location, relative):
            yield sha, relative
    walked: set[tuple[bytes, str]] = set()

    def walk(tree_id: bytes, base: str) -> Iterator[tuple[bytes, str]]:
        if (tree_id, base) in walked:
            return
        walked.add((tree_id, base))
        yield tree_id, base
        tree = repo.object_store[ObjectID(tree_id)]
        if not isinstance(tree, Tree):
            return
        for entry in tree.iteritems():
            relative = posixpath.join(
                base, entry.path.decode("utf-8", "surrogateescape")
            )
            if not visible_path(location, relative):
                continue
            if entry.mode == TREE:
                yield from walk(entry.sha, relative)
            else:
                yield entry.sha, relative

    pending: list[bytes] = []
    for ref in repo.refs.allkeys():
        try:
            pending.append(repo.refs[ref])
        except KeyError:
            continue
    reached: set[bytes] = set()
    while pending:
        head = pending.pop()
        if head in reached:
            continue
        reached.add(head)
        try:
            obj = repo.object_store[ObjectID(head)]
        except KeyError:
            continue
        if isinstance(obj, Tag):
            pending.append(obj.object[1])
        elif isinstance(obj, Commit):
            pending.extend(obj.parents)
            yield from walk(obj.tree, "")
