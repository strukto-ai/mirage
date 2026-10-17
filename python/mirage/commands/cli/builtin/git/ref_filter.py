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

from collections.abc import Sequence
from dataclasses import dataclass

from dulwich.objects import Commit, ObjectID, ShaFile, Tag
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.constants import HEAD
from mirage.commands.cli.builtin.git.errors import (
    GitError,
    MalformedMergeFilterError,
    MalformedObjectError,
    NotACommitError,
)
from mirage.commands.cli.builtin.git.history import peel_to_commit
from mirage.commands.cli.builtin.git.revparse import (
    resolve_object,
    tag_object,
    unwrapped,
)
from mirage.commands.cli.constants import GIT_LONG_OPTIONS
from mirage.commands.config import Context
from mirage.commands.spec.compile import compile_spec, expand_git_long

CONTAINS = "--contains"
NO_CONTAINS = "--no-contains"
MERGED = "--merged"
NO_MERGED = "--no-merged"
POINTS_AT = "--points-at"
MARKER = "--"

# The order git names a filter in when a line that deletes holds one.
LIST_MODE_ORDER = (CONTAINS, NO_CONTAINS, POINTS_AT, MERGED, NO_MERGED)


@dataclass(frozen=True, slots=True)
class FilterWord:
    """One ref-filter option as the line spelled it, in line order.

    Args:
        option (str): the option's full long spelling, e.g.
            ``--contains``.
        value (str): the commit or object it names.
        operand (bool): whether the parser left the value among the
            operands, which is where a detached value of an
            optional-value option lands.
    """

    option: str
    value: str
    operand: bool


@dataclass(frozen=True, slots=True)
class RefFilter:
    """The commits and objects a listing is narrowed by, resolved.

    Args:
        contains (tuple[bytes, ...]): the ``--contains`` commits.
        no_contains (tuple[bytes, ...]): the ``--no-contains`` commits.
        merged (frozenset[bytes] | None): every commit reachable from a
            ``--merged`` commit, None without one.
        no_merged (frozenset[bytes] | None): every commit reachable from
            a ``--no-merged`` commit, None without one.
        points_at (tuple[bytes, ...]): the ``--points-at`` objects.
    """

    contains: tuple[bytes, ...]
    no_contains: tuple[bytes, ...]
    merged: frozenset[bytes] | None
    no_merged: frozenset[bytes] | None
    points_at: tuple[bytes, ...]


def filter_words(ctx: Context) -> list[FilterWord]:
    """The ref-filter options a line holds, read off its verbatim argv.

    The four commit filters take the next word as their commit, whatever
    it looks like, except as the line's last word, where they read HEAD:
    parse-options' LASTARG_DEFAULT. They are declared with an optional
    value, so a detached value reached the operands, and this is where
    it is reattached. Every other option is skipped by the leaf's own
    spec, so a value that happens to spell a filter (``tag -m
    --contains``) stays that option's value, and the scan stops at
    ``--`` the way the parser does. A long spelling may be a unique
    prefix (``--cont``), as git's parse-options accepts.

    Args:
        ctx (Context): the line's context, whose ``spec`` is the leaf
            that parsed it.
    """
    if ctx.spec is None:
        return []
    cs = compile_spec(ctx.spec)
    argv = ctx.argv
    words: list[FilterWord] = []
    i = 0
    while i < len(argv):
        token = argv[i]
        if token == MARKER:
            break
        if token.startswith("--"):
            typed, eq, attached = token.partition("=")
            expanded = expand_git_long(
                GIT_LONG_OPTIONS.get(ctx.spec.name, ()), typed
            )
            spelling = expanded if isinstance(expanded, str) else typed
            if spelling in LIST_MODE_ORDER:
                if eq:
                    words.append(FilterWord(spelling, attached, False))
                elif i + 1 < len(argv):
                    i += 1
                    value = argv[i]
                    operand = spelling != POINTS_AT and (
                        value == "-" or not value.startswith("-")
                    )
                    words.append(FilterWord(spelling, value, operand))
                else:
                    words.append(FilterWord(spelling, HEAD, False))
            elif not eq and spelling in cs.long_value_spellings:
                i += 1
        elif token.startswith("-") and token != "-":
            for j in range(1, len(token)):
                short = f"-{token[j]}"
                if short in cs.value_spellings:
                    if j == len(token) - 1:
                        i += 1
                    break
                if short in cs.attach_spellings:
                    break
        i += 1
    return words


def without_filter_values(
    texts: Sequence[str], words: list[FilterWord]
) -> tuple[str, ...]:
    """The operands left once the filter values the parser kept are out.

    Only a listing reads what is left, as name patterns, and patterns
    are alternatives, so which of two equal words goes makes no
    difference.

    Args:
        texts (Sequence[str]): the operands as parsed.
        words (list[FilterWord]): the line's filter options.
    """
    left = list(texts)
    for word in words:
        if word.operand and word.value in left:
            left.remove(word.value)
    return tuple(left)


def list_mode_option(words: list[FilterWord]) -> str | None:
    """The filter a line that deletes is refused for holding, in git's
    order.

    Args:
        words (list[FilterWord]): the line's filter options.
    """
    held = {word.option for word in words}
    return next((option for option in LIST_MODE_ORDER if option in held), None)


def _object_for(repo: BaseRepo, word: FilterWord) -> ShaFile:
    """The object a filter names, or git's refusal for the option.

    Args:
        repo (BaseRepo): the opened repository.
        word (FilterWord): the filter option.
    """
    try:
        if word.option == POINTS_AT:
            held = tag_object(repo, word.value)
            return (
                held if held is not None else resolve_object(repo, word.value)
            )
        return resolve_object(repo, word.value)
    except GitError as exc:
        if word.option in (MERGED, NO_MERGED):
            raise MalformedMergeFilterError(word.value) from exc
        raise MalformedObjectError(
            word.value, word.option == POINTS_AT
        ) from exc


def _commit_for(repo: BaseRepo, word: FilterWord) -> bytes:
    """The commit a commit filter names, tags peeled.

    Args:
        repo (BaseRepo): the opened repository.
        word (FilterWord): the filter option.
    """
    found = unwrapped(repo, _object_for(repo, word), word.value)
    if isinstance(found, Commit):
        return found.id
    reason = (
        f"option `{word.option[2:]}' must point to a commit"
        if word.option in (MERGED, NO_MERGED)
        else f"no such commit {word.value}"
    )
    raise NotACommitError(found.id.decode(), found.type_name.decode(), reason)


def _ancestry(repo: BaseRepo, shas: list[bytes]) -> frozenset[bytes]:
    """Every commit reachable from the given ones, themselves included.

    Args:
        repo (BaseRepo): the opened repository.
        shas (list[bytes]): the commits to start from.
    """
    seen: set[bytes] = set()
    stack = list(shas)
    while stack:
        sha = stack.pop()
        if sha in seen:
            continue
        seen.add(sha)
        commit = repo.object_store[ObjectID(sha)]
        if isinstance(commit, Commit):
            stack.extend(commit.parents)
    return frozenset(seen)


def ref_filter(repo: BaseRepo, words: list[FilterWord]) -> RefFilter | None:
    """Resolve a line's filter options, in line order, None when it holds
    none.

    In line order because git resolves each as it parses it, so the
    first bad name on the line is the one refused. Synchronous: the
    ancestry walks read objects, so callers run it on a worker thread.

    Args:
        repo (BaseRepo): the opened repository.
        words (list[FilterWord]): the line's filter options.
    """
    if not words:
        return None
    lists: dict[str, list[bytes]] = {option: [] for option in LIST_MODE_ORDER}
    for word in words:
        sha = (
            _object_for(repo, word).id
            if word.option == POINTS_AT
            else _commit_for(repo, word)
        )
        lists[word.option].append(sha)
    merged, no_merged = lists[MERGED], lists[NO_MERGED]
    return RefFilter(
        contains=tuple(lists[CONTAINS]),
        no_contains=tuple(lists[NO_CONTAINS]),
        merged=_ancestry(repo, merged) if merged else None,
        no_merged=_ancestry(repo, no_merged) if no_merged else None,
        points_at=tuple(lists[POINTS_AT]),
    )


def _reaches(
    repo: BaseRepo,
    tip: bytes,
    targets: frozenset[bytes],
    memo: dict[bytes, bool],
) -> bool:
    """Whether a commit reaches any of the targets, memoised across calls.

    One memo per target set turns a listing of many refs into one walk
    of the history they share, which is how git answers ``tag
    --contains`` over thousands of tags.

    Args:
        repo (BaseRepo): the opened repository.
        tip (bytes): the commit to start from.
        targets (frozenset[bytes]): the commits to look for.
        memo (dict[bytes, bool]): answers so far, shared per target set.
    """
    stack: list[tuple[bytes, bool]] = [(tip, False)]
    while stack:
        sha, expanded = stack.pop()
        if sha in memo:
            continue
        if sha in targets:
            memo[sha] = True
            continue
        commit = repo.object_store[ObjectID(sha)]
        parents = commit.parents if isinstance(commit, Commit) else []
        if expanded:
            memo[sha] = any(memo.get(parent, False) for parent in parents)
            continue
        stack.append((sha, True))
        stack.extend(
            (parent, False) for parent in parents if parent not in memo
        )
    return memo.get(tip, False)


def _points_at(repo: BaseRepo, sha: bytes, objects: tuple[bytes, ...]) -> bool:
    """Whether a ref points at one of the objects, directly or through
    its tag.

    Args:
        repo (BaseRepo): the opened repository.
        sha (bytes): the object the ref points at.
        objects (tuple[bytes, ...]): the ``--points-at`` objects.
    """
    if sha in objects:
        return True
    obj = repo.object_store[ObjectID(sha)]
    return isinstance(obj, Tag) and obj.object[1] in objects


def kept_refs(
    repo: BaseRepo, filt: RefFilter, refs: Sequence[tuple[str, bytes]]
) -> set[str]:
    """The names of the refs a filter keeps, from ``(name, object)``
    pairs.

    git's order of tests: ``--points-at`` on the ref's own object (or
    the one its tag object points at, one level down), then the commit
    filters, which drop a ref that peels to no commit at all.
    Synchronous, for a worker thread.

    Args:
        repo (BaseRepo): the opened repository.
        filt (RefFilter): the resolved filter.
        refs (Sequence[tuple[str, bytes]]): each candidate ref's name
            and the object it points at.
    """
    kept: set[str] = set()
    contains, no_contains = (
        frozenset(filt.contains),
        frozenset(filt.no_contains),
    )
    contains_memo: dict[bytes, bool] = {}
    no_contains_memo: dict[bytes, bool] = {}
    by_commit = bool(
        contains
        or no_contains
        or filt.merged is not None
        or filt.no_merged is not None
    )
    for name, sha in refs:
        if filt.points_at and not _points_at(repo, sha, filt.points_at):
            continue
        if by_commit:
            commit = peel_to_commit(repo, sha)
            if commit is None:
                continue
            if contains and not _reaches(
                repo, commit.id, contains, contains_memo
            ):
                continue
            if no_contains and _reaches(
                repo, commit.id, no_contains, no_contains_memo
            ):
                continue
            if filt.merged is not None and commit.id not in filt.merged:
                continue
            if filt.no_merged is not None and commit.id in filt.no_merged:
                continue
        kept.add(name)
    return kept
