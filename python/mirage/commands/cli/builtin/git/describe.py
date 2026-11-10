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


import asyncio
import heapq
from dataclasses import dataclass

from dulwich.objects import Commit, ObjectID, ShaFile, Tag, Tree
from dulwich.repo import BaseRepo

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.changes import (
    head_entries,
    staged_entries,
    work_entries,
)
from mirage.commands.cli.builtin.git.errors import (
    ConfigUsageError,
    GitError,
    UsageError,
)
from mirage.commands.cli.builtin.git.format import abbrev_width
from mirage.commands.cli.builtin.git.index_file import read_index
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.ref_list import (
    ref_table,
    resolve_ref,
    unique_abbreviations,
)
from mirage.commands.cli.builtin.git.revparse import (
    resolve_commit,
    resolve_object,
    shallow_commits,
)
from mirage.commands.cli.builtin.git.seen import shown_entries
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.util import (
    lone_help,
    option_operand,
    require_vfs,
    verb_usage,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.fnmatch import fnmatch

TAG_NAMESPACE = "refs/tags/"
BRANCH_NAMESPACE = "refs/heads/"
REMOTE_NAMESPACE = "refs/remotes/"
REFS_NAMESPACE = "refs/"
DEFAULT_CANDIDATES = 10
DIRTY_MARK = "-dirty"
ANNOTATED = 2
LIGHTWEIGHT = 1
OTHER_REF = 0
NO_ABBREVIATION = 0


@dataclass(frozen=True, slots=True)
class _Name:
    """A ref that could describe a commit.

    Args:
        text (str): how the description spells it.
        commit (ObjectID): the commit it points at.
        priority (int): annotated tags over others, tags over other refs.
        when (int): the tag's date, newer preferred on one commit.
    """

    text: str
    commit: ObjectID
    priority: int
    when: int


def _number_of(value: FlagValue | None, option: str) -> int | None:
    """An option's numeric value, None when it has none.

    Args:
        value (FlagValue | None): the option's value.
        option (str): its name, for the refusal.

    Raises:
        ConfigUsageError: the value is not a number.
    """
    if not isinstance(value, str):
        return None
    if not value.isascii() or not value.isdigit():
        raise ConfigUsageError(f"option `{option}' expects a numerical value")
    return int(value)


def _peeled_tag(repo: BaseRepo, oid: str) -> tuple[ShaFile, bool, int]:
    """What a ref finally names, whether a tag led there, and that tag's time.

    Args:
        repo (BaseRepo): the opened repository.
        oid (str): the object the ref names.
    """
    found = repo.object_store[ObjectID(oid.encode())]
    annotated = isinstance(found, Tag)
    when = found.tag_time if isinstance(found, Tag) else 0
    while isinstance(found, Tag):
        found = repo.object_store[found.object[1]]
    return found, annotated, when


def _names_of(
    repo: BaseRepo, fl: FlagView, take_light: bool
) -> dict[ObjectID, _Name]:
    """The best name each commit has, as the line's options allow.

    Args:
        repo (BaseRepo): the opened repository.
        fl (FlagView): parsed flags.
        take_light (bool): whether lightweight tags count.
    """
    table = ref_table(repo)
    every_ref = fl.as_bool("all")
    matches = fl.as_list("match")
    excludes = fl.as_list("exclude")
    chosen: dict[ObjectID, _Name] = {}
    for ref in sorted(table):
        if ref.startswith(TAG_NAMESPACE):
            short = ref[len(TAG_NAMESPACE) :]
        elif every_ref and ref.startswith(BRANCH_NAMESPACE):
            short = ref[len(BRANCH_NAMESPACE) :]
        elif every_ref and ref.startswith(REMOTE_NAMESPACE):
            short = ref[len(REMOTE_NAMESPACE) :]
        elif every_ref and ref.startswith(REFS_NAMESPACE):
            short = ref[len(REFS_NAMESPACE) :]
        else:
            continue
        if matches and not any(fnmatch(short, p) for p in matches):
            continue
        if any(fnmatch(short, p) for p in excludes):
            continue
        oid, _ = resolve_ref(table, ref)
        if oid is None:
            continue
        found, annotated, when = _peeled_tag(repo, oid)
        priority = OTHER_REF
        if ref.startswith(TAG_NAMESPACE):
            priority = ANNOTATED if annotated else LIGHTWEIGHT
        if priority == LIGHTWEIGHT and not take_light:
            continue
        if not isinstance(found, Commit):
            continue
        text = ref[len(REFS_NAMESPACE) :] if every_ref else short
        name = _Name(text, found.id, priority, when)
        held = chosen.get(found.id)
        if held is None or (priority, when) > (held.priority, held.when):
            chosen[found.id] = name
    return chosen


def _parents_of(
    commit: Commit, first_parent: bool, shallow: set[bytes]
) -> list[ObjectID]:
    if commit.id in shallow:
        return []
    return commit.parents[:1] if first_parent else commit.parents


def _reach(
    repo: BaseRepo,
    start: ObjectID,
    first_parent: bool,
    shallow: set[bytes],
) -> set[ObjectID]:
    """Every commit a walk from one commit reaches, itself included.

    Args:
        repo (BaseRepo): the opened repository.
        start (ObjectID): where the walk starts.
        first_parent (bool): whether to follow first parents only.
        shallow (set[bytes]): the commits whose parents are absent.
    """
    seen = {start}
    pending = [start]
    while pending:
        commit = repo.object_store[pending.pop()]
        assert isinstance(commit, Commit)
        for parent in _parents_of(commit, first_parent, shallow):
            if parent not in seen:
                seen.add(parent)
                pending.append(parent)
    return seen


def _nearest(
    repo: BaseRepo,
    target: Commit,
    names: dict[ObjectID, _Name],
    limit: int,
    first_parent: bool,
    shallow: set[bytes],
) -> tuple[_Name, int] | None:
    """The name closest to a commit and how many commits lie past it.

    A newest-first walk gathers up to ``limit`` names it meets; each is
    scored by the commits the target has that the name does not reach,
    and the first with the lowest score is kept.

    Args:
        repo (BaseRepo): the opened repository.
        target (Commit): the commit to describe.
        names (dict[ObjectID, _Name]): the best name of each commit.
        limit (int): how many names to weigh.
        first_parent (bool): whether to follow first parents only.
        shallow (set[bytes]): the commits whose parents are absent.
    """
    queue = [(-target.commit_time, target.id)]
    seen = {target.id}
    met: list[_Name] = []
    while queue and len(met) < max(limit, 1):
        _, oid = heapq.heappop(queue)
        if oid in names:
            met.append(names[oid])
        commit = repo.object_store[oid]
        assert isinstance(commit, Commit)
        for parent in _parents_of(commit, first_parent, shallow):
            if parent in seen:
                continue
            seen.add(parent)
            found = repo.object_store[parent]
            assert isinstance(found, Commit)
            heapq.heappush(queue, (-found.commit_time, parent))
    if not met:
        return None
    reached = _reach(repo, target.id, first_parent, shallow)
    best: tuple[_Name, int] | None = None
    for name in met:
        depth = len(reached - _reach(repo, name.commit, first_parent, shallow))
        if best is None or depth < best[1]:
            best = (name, depth)
    return best


def _short(repo: BaseRepo, oid: str, width: int) -> str:
    return oid[: unique_abbreviations(repo, {oid: width})[oid]]


def _described(
    repo: BaseRepo,
    target: Commit,
    names: dict[ObjectID, _Name],
    fl: FlagView,
    width: int,
    lightweight: dict[ObjectID, _Name],
    shallow: set[bytes],
) -> str:
    """One commit's description.

    Args:
        repo (BaseRepo): the opened repository.
        target (Commit): the commit to describe.
        names (dict[ObjectID, _Name]): the best name of each commit.
        fl (FlagView): parsed flags.
        width (int): the digits of the commit's id; 0 drops the suffix.
        lightweight (dict[ObjectID, _Name]): every tag, when the line
            left the lightweight ones out.
        shallow (set[bytes]): the commits whose parents are absent.

    Raises:
        GitError: no name describes it.
    """
    oid = target.id.decode()
    exact = fl.as_bool("exact_match")
    limit = _number_of(fl.raw("candidates"), "candidates")
    candidates = 0 if exact else DEFAULT_CANDIDATES if limit is None else limit
    found = (names[target.id], 0) if target.id in names else None
    if found is None and candidates != 0:
        found = _nearest(
            repo,
            target,
            names,
            candidates,
            fl.as_bool("first_parent"),
            shallow,
        )
    if found is None:
        if exact or candidates == 0:
            raise GitError(f"no tag exactly matches '{oid}'")
        if fl.as_bool("always"):
            return _short(repo, oid, width or len(oid))
        if not names and not lightweight:
            raise GitError("No names found, cannot describe anything.")
        if lightweight and _nearest(
            repo,
            target,
            lightweight,
            DEFAULT_CANDIDATES,
            fl.as_bool("first_parent"),
            shallow,
        ):
            raise GitError(
                f"No annotated tags can describe '{oid}'.\n"
                "However, there were unannotated tags: try --tags."
            )
        raise GitError(
            f"No tags can describe '{oid}'.\n"
            "Try --always, or create some tags."
        )
    name, depth = found
    if width == NO_ABBREVIATION or (depth == 0 and not fl.as_bool("long")):
        return name.text
    return f"{name.text}-{depth}-g{_short(repo, oid, width)}"


def _describe_all(
    repo: BaseRepo, revisions: list[str], fl: FlagView, width: int
) -> list[str]:
    """Every description the line asks for.

    Args:
        repo (BaseRepo): the opened repository.
        revisions (list[str]): the commits, as typed.
        fl (FlagView): parsed flags.
        width (int): the digits of each commit's id.
    """
    light = fl.as_bool("all") or fl.as_bool("tags")
    names = _names_of(repo, fl, light)
    lightweight = {} if light else _names_of(repo, fl, True)
    shallow = shallow_commits(repo)
    lines = []
    for revision in revisions:
        try:
            found = resolve_object(repo, revision)
        except GitError as exc:
            raise GitError(f"Not a valid object name {revision}") from exc
        if isinstance(found, Tree):
            raise GitError(f"{revision} is neither a commit nor blob")
        lines.append(
            _described(
                repo,
                resolve_commit(repo, revision),
                names,
                fl,
                width,
                lightweight,
                shallow,
            )
        )
    return lines


async def _is_dirty(ctx: Context, fl: FlagView) -> bool:
    """Whether the work tree differs from HEAD.

    Args:
        ctx (Context): the line's context.
        fl (FlagView): parsed flags.
    """
    vfs = require_vfs(ctx)
    repo, location = await opened(ctx, fl, work_tree=True)
    state = await read_index(vfs, location.gitdir)
    committed = await asyncio.to_thread(head_entries, repo)
    head = shown_entries(repo, committed or {})
    staged = shown_entries(repo, staged_entries(state))
    if head != staged:
        return True
    return await work_entries(vfs, repo, location, state) != staged


def _mark(value: FlagValue | None, default: str) -> str:
    return value if isinstance(value, str) else default


async def describe(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Name a commit after the nearest tag.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the commits.
        ctx (Context): the line's context.
    """
    fl = FlagView(ctx.flags)
    if option_operand(ctx, texts, lone_help(ctx, texts)) is not None:
        raise UsageError("", verb_usage(ctx))
    dirty = fl.raw("dirty")
    broken = fl.raw("broken")
    marked = dirty is not None or broken is not None
    if marked and texts:
        raise GitError(
            "option '--dirty' and commit-ishes cannot be used together"
        )
    abbrev = _number_of(fl.raw("abbrev"), "abbrev")
    if abbrev == NO_ABBREVIATION and fl.as_bool("long"):
        raise GitError(
            "options '--long' and '--abbrev=0' cannot be used together"
        )
    _number_of(fl.raw("candidates"), "candidates")
    repo, _ = await opened(ctx, fl)
    width = (
        abbrev_for(repo)
        if abbrev is None
        else NO_ABBREVIATION
        if abbrev == NO_ABBREVIATION
        else abbrev_width(str(abbrev), abbrev_for(repo))
    )
    lines = await asyncio.to_thread(
        _describe_all, repo, list(texts) or ["HEAD"], fl, width
    )
    suffix = ""
    if marked and await _is_dirty(ctx, fl):
        suffix = _mark(dirty if dirty is not None else broken, DIRTY_MARK)
    return "".join(f"{line}{suffix}\n" for line in lines).encode(), IOResult()
