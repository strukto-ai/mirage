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

import heapq
import math
import re
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from typing import Literal

import regex
from dulwich.objects import Commit, ObjectID, Tag
from dulwich.refs import HEADREF, LOCAL_BRANCH_PREFIX, LOCAL_TAG_PREFIX
from dulwich.repo import BaseRepo

from mirage.commands.builtin.utils.bre import (
    BreError,
    PosixSyntax,
    search_bre,
    translate_ere,
)
from mirage.commands.cli.builtin.git.dates import date_clock, parse_date_mode
from mirage.commands.cli.builtin.git.errors import (
    BadDateError,
    GitError,
    IncompatibleLogOptionsError,
    InvalidDecorateError,
    UnrecognizedArgumentError,
)
from mirage.commands.cli.builtin.git.format import (
    DEFAULT_DATE,
    MEDIUM,
    LogFormat,
    needs_decorations,
    parse_pretty,
)
from mirage.commands.cli.builtin.git.mailmap import mapped_identity
from mirage.commands.cli.builtin.git.pickaxe import touches
from mirage.commands.cli.builtin.git.repo import config_values
from mirage.commands.cli.builtin.git.types import (
    DateMode,
    Decoration,
    MailmapEntry,
    RepoLocation,
)
from mirage.commands.cli.builtin.git.util import maybe_bool
from mirage.commands.spec.flag_view import FlagView
from mirage.runtime.types import DispatchFn
from mirage.utils.dates import iso_timestamp
from mirage.utils.posix import compile_posix_regex

REMOTE_PREFIX = b"refs/remotes/"
BASIC_REGEXP = "basic_regexp"
EXTENDED_REGEXP = "extended_regexp"
FIXED_STRINGS = "fixed_strings"
PERL_REGEXP = "perl_regexp"
# The pattern syntax switches; the last one on the line wins.
PATTERN_SYNTAXES = (BASIC_REGEXP, EXTENDED_REGEXP, FIXED_STRINGS, PERL_REGEXP)
COMMAND_LINE_ORIGIN = "command line"
HEADER_ORIGIN = "header"
# How many hidden commits a limited walk takes past the point where only
# hidden ones are queued, git's SLOP.
SLOP = 5


@dataclass(frozen=True, slots=True)
class LogFlags:
    """The parsed shape of a ``git log`` invocation.

    Args:
        max_count (int | None): ``-n``/``--max-count``, how many commits
            to print; None when unlimited.
        oneline (bool): ``--oneline``, one abbreviated row per commit.
        reverse (bool): ``--reverse``, oldest first.
        search (str | None): ``-S``, the pickaxe string.
        since (float | None): ``--since`` as an epoch second.
        until (float | None): ``--until`` as an epoch second.
        authors (tuple[re.Pattern[str], ...]): author patterns, ORed together.
        greps (tuple[re.Pattern[str], ...]): ``--grep`` patterns, any of
            which may match a line of the message.
        committers (tuple[re.Pattern[str], ...]): ``--committer``
            patterns, ORed together.
        mailmap (tuple[MailmapEntry, ...]): the worktree ``.mailmap``,
            which ``%aN``-style placeholders always read.
        use_mailmap (bool): ``log.mailmap`` or ``--[no-]mailmap``: map
            the header identities and what ``--author`` and
            ``--committer`` match.
        ignore_case (bool): ``-i``, which folds case for ``--grep``,
            ``--author`` and ``-S`` alike.
        decorate (Decoration): how commits are labelled with their
            refs; parse_flags leaves it off, and ``decoration_for``
            settles it once the repository's config can be read.
        all_refs (bool): ``--all``, start from every ref as well.
        pretty (LogFormat): how each commit renders; medium unless
            ``--oneline`` or ``--pretty``/``--format`` said otherwise.
        abbrev_commit (bool): print abbreviated ids, which ``--oneline``
            implies and ``--pretty=oneline`` alone does not.
        graph (bool): ``--graph``, draw the history beside the commits.
        order (str): the walk order: newest first (``default``),
            ``topo`` (``--topo-order``, which ``--graph`` implies) or
            ``date`` (``--date-order``).
    """

    max_count: int | None
    oneline: bool
    reverse: bool
    search: str | None
    since: float | None
    until: float | None
    authors: tuple[re.Pattern[str], ...] = ()
    greps: tuple[re.Pattern[str], ...] = ()
    committers: tuple[re.Pattern[str], ...] = ()
    mailmap: tuple[MailmapEntry, ...] = ()
    use_mailmap: bool = True
    ignore_case: bool = False
    date: DateMode = DEFAULT_DATE
    decorate: Decoration = Decoration.NONE
    all_refs: bool = False
    pretty: LogFormat = MEDIUM
    abbrev_commit: bool = False

    min_parents: int | None = None
    max_parents: int | None = None
    first_parent: bool = False
    graph: bool = False
    order: Literal["default", "topo", "date"] = "default"


@dataclass(frozen=True, slots=True)
class WalkStep:
    """One commit of a walk: drawn by ``--graph`` always, printed unless
    ``-S`` passed it by.

    Args:
        commit (Commit): the commit.
        shown (bool): whether the log prints it.
    """

    commit: Commit
    shown: bool


@dataclass(frozen=True, slots=True)
class Walk:
    """The commits a log walks, in order, and the ones a graph may draw
    an edge to.

    Args:
        steps (tuple[WalkStep, ...]): the walked commits.
        interesting (frozenset[bytes]): every commit in the walk that no
            filter leaves out, which is what makes it a parent
            ``--graph`` draws a line to. Filled only for an ordered walk.
    """

    steps: tuple[WalkStep, ...]
    interesting: frozenset[bytes]


def _timestamp(value: str | None, flag: str) -> float | None:
    """Read a date flag as an epoch second, refusing what it cannot read.

    Accepts an ISO-8601 date or a bare epoch second. git accepts far
    more (``2 weeks ago``, ``yesterday``); anything else is refused here
    rather than silently ignored, which would quietly widen the window.

    Args:
        value (str | None): the flag's value.
        flag (str): flag name, for error attribution.
    """
    if value is None:
        return None
    parsed = iso_timestamp(value)
    if parsed is not None:
        return parsed
    try:
        return float(value)
    except ValueError as exc:
        raise BadDateError(flag, value) from exc


def pretty_format(fl: FlagView) -> LogFormat:
    """Read display formats in command-line order, as Git does.

    Each occurrence is validated before a later option replaces it.
    ``--oneline`` sets the format; its abbreviation side effect is read
    separately by the caller. Bare ``--pretty`` resets to medium, while
    bare ``--format`` is always an error (Git 2.50.1).

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    pretty = MEDIUM
    for key, raw in fl.occurrences("oneline", "pretty", "format"):
        if key == "oneline":
            if raw is True:
                pretty = LogFormat(kind="oneline")
        elif isinstance(raw, str):
            pretty = parse_pretty(raw)
        elif raw is True:
            if key == "format":
                raise UnrecognizedArgumentError("--format")
            pretty = MEDIUM
    return pretty


def _pattern(
    value: str, syntax: str, ignore_case: bool, origin: str
) -> re.Pattern[str]:
    """One ``--grep``, ``--author`` or ``--committer`` pattern, compiled.

    ``-P`` goes to the ``regex`` engine, whose syntax is PCRE's where
    Python's ``re`` is not (``\\p{L}``, ``[[:alpha:]]``, ``\\K``), with
    ASCII escapes as PCRE2 reads them without UCP. A refusal names where
    the pattern came from and the pattern itself, as git's
    ``compile_regexp_failed`` words it; the reason after that is glibc's
    for a basic expression and the host engine's otherwise.

    Args:
        value (str): the pattern as typed.
        syntax (str): which of ``PATTERN_SYNTAXES`` reads it.
        ignore_case (bool): ``-i``/``--regexp-ignore-case``.
        origin (str): git's name for where the pattern came from.
    """
    try:
        if syntax == PERL_REGEXP:
            perl: re.Pattern[str] = regex.compile(
                value, regex.ASCII | (regex.IGNORECASE if ignore_case else 0)
            )
            return perl
        fold = re.IGNORECASE if ignore_case else 0
        if syntax == FIXED_STRINGS:
            return compile_posix_regex(re.escape(value), fold)
        if syntax == EXTENDED_REGEXP:
            return compile_posix_regex(
                translate_ere(value, PosixSyntax.EXTENDED)[0], fold
            )
        return search_bre(value, ignore_case)
    except (BreError, re.error, regex.error) as exc:
        raise GitError(f"{origin}, '{value}': {exc}") from exc


def parse_flags(
    fl: FlagView, env: Mapping[str, str] | None = None
) -> LogFlags:
    """Read the raw log flag kwargs into a frozen struct.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        env (Mapping[str, str] | None): the command environment, whose
            ``TZ`` and ``GIT_TEST_DATE_NOW`` set the clock dates are
            rendered by.
    """
    oneline = fl.as_bool("oneline")
    pretty = pretty_format(fl)
    graph = fl.as_bool("graph")
    if graph and fl.as_bool("reverse"):
        raise IncompatibleLogOptionsError("--graph", "--reverse")
    order: Literal["default", "topo", "date"] = "topo" if graph else "default"
    for name in fl.typed_order("topo_order", "date_order"):
        if fl.as_bool(name):
            order = "topo" if name == "topo_order" else "date"
    ignore_case = fl.as_bool("regexp_ignore_case")
    syntax = BASIC_REGEXP
    for key, _ in fl.occurrences(*PATTERN_SYNTAXES):
        syntax = key
    committers = tuple(
        _pattern(value, syntax, ignore_case, HEADER_ORIGIN)
        for value in fl.as_list("committer")
    )
    authors = tuple(
        _pattern(value, syntax, ignore_case, HEADER_ORIGIN)
        for value in fl.as_list("author")
    )
    greps = tuple(
        _pattern(value, syntax, ignore_case, COMMAND_LINE_ORIGIN)
        for values in fl.as_list("grep")
        for value in values.split("\n")
    )
    max_count = fl.as_int("max_count")
    return LogFlags(
        authors=authors,
        committers=committers,
        greps=greps,
        ignore_case=ignore_case,
        date=parse_date_mode(fl.as_str("date") or "default", date_clock(env)),
        # git reads a negative count as no limit at all.
        max_count=None
        if max_count is not None and max_count < 0
        else max_count,
        min_parents=2 if fl.as_bool("merges") else fl.as_int("min_parents"),
        max_parents=1 if fl.as_bool("no_merges") else fl.as_int("max_parents"),
        first_parent=fl.as_bool("first_parent"),
        oneline=oneline,
        reverse=fl.as_bool("reverse"),
        search=fl.as_str("S"),
        since=_timestamp(fl.as_str("after") or fl.as_str("since"), "--since"),
        until=_timestamp(fl.as_str("before") or fl.as_str("until"), "--until"),
        all_refs=fl.as_bool("all"),
        pretty=pretty,
        abbrev_commit=oneline,
        graph=graph,
        order=order,
    )


def peel_to_commit(repo: BaseRepo, sha: bytes) -> Commit | None:
    """Follow tag objects down to the commit a ref ultimately names.

    Args:
        repo (BaseRepo): repository whose store resolves the ids.
        sha (bytes): hex object id a ref points at.
    """
    obj = repo.object_store[ObjectID(sha)]
    while isinstance(obj, Tag):
        _, target = obj.object
        obj = repo.object_store[ObjectID(target)]
    return obj if isinstance(obj, Commit) else None


def ref_commits(repo: BaseRepo) -> list[Commit]:
    """Every commit a ref points at, tags peeled, for ``--all``.

    Args:
        repo (BaseRepo): repository whose refs to enumerate.
    """
    commits: list[Commit] = []
    for name in sorted(repo.refs.allkeys()):
        try:
            sha = repo.refs[name]
        except KeyError:
            # A symref to an unborn branch names nothing yet.
            continue
        commit = peel_to_commit(repo, sha)
        if commit is not None:
            commits.append(commit)
    return commits


def decoration_style(value: bytes) -> Decoration | None:
    """``parse_decoration_style``: the style a value names, None for none.

    A boolean word or number, ``short``, ``full`` or ``auto``, which
    decorates only a terminal and so never here.

    Args:
        value (bytes): the ``--decorate=`` or ``log.decorate`` value.
    """
    flag = maybe_bool(value)
    if flag is not None:
        return Decoration.SHORT if flag else Decoration.NONE
    if value == b"short":
        return Decoration.SHORT
    if value == b"full":
        return Decoration.FULL
    if value == b"auto":
        return Decoration.NONE
    return None


async def decoration_for(
    dispatch: DispatchFn,
    location: RepoLocation,
    fl: FlagView,
    pretty: LogFormat,
) -> Decoration:
    """How a ``log`` or ``show`` line labels its commits.

    As git's ``cmd_log_init_finish`` settles it (pinned against git
    2.47.3): ``log.decorate`` sets the style, a value it cannot read
    meaning none, and the line's ``--decorate[=<style>]`` and
    ``--no-decorate`` override it, the last one typed winning;
    ``--pretty=raw`` ignores the config. A template that prints ``%d``
    or ``%D`` is decorated even when nothing asked, by short names
    unless a style says full, and one that prints neither loads no
    labels at all.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
        fl (FlagView): the line's flags.
        pretty (LogFormat): the line's format.

    Raises:
        InvalidDecorateError: a ``--decorate`` value that names no style.
    """
    style: Decoration | None = None
    for key, value in fl.occurrences("decorate", "no_decorate"):
        if key == "no_decorate":
            style = Decoration.NONE
        elif not isinstance(value, str):
            style = Decoration.SHORT
        else:
            style = decoration_style(value.encode())
            if style is None:
                raise InvalidDecorateError(value)
    if style is None and pretty.kind != "raw":
        configured = await config_values(
            dispatch, location, b"log", b"decorate"
        )
        if configured:
            style = decoration_style(configured[-1])
    if style is None:
        style = Decoration.NONE
    if pretty.kind not in ("format", "tformat"):
        return style
    if not needs_decorations(pretty):
        return Decoration.NONE
    return Decoration.SHORT if style is Decoration.NONE else style


def decorations(
    repo: BaseRepo, style: Decoration = Decoration.SHORT
) -> dict[bytes, list[str]]:
    """Ref labels per commit, in the order git prints them.

    git walks refs alphabetically and prepends each label, so a
    commit's labels read in reverse ref order; HEAD is pulled to the
    front, spelled ``HEAD -> branch`` when attached (the branch's own
    label is absorbed) and ``HEAD`` alone when detached. Pinned against
    git 2.50.

    Args:
        repo (BaseRepo): repository whose refs to enumerate.
        style (Decoration): ``FULL`` keeps each ref's whole name;
            anything else shortens it.
    """
    full = style is Decoration.FULL
    labels: dict[bytes, list[str]] = {}
    for name in sorted(repo.refs.allkeys()):
        if name == HEADREF:
            continue
        try:
            sha = repo.refs[name]
        except KeyError:
            continue
        commit = peel_to_commit(repo, sha)
        if commit is None:
            continue
        labels.setdefault(commit.id, []).insert(0, _ref_label(name, full))
    _decorate_head(repo, labels, full)
    return labels


def _ref_label(name: bytes, full: bool) -> str:
    """One ref's decoration label, in git's spelling, by its short or
    its full name.

    Args:
        name (bytes): the full ref name.
        full (bool): keep the whole name.
    """
    text = name.decode("utf-8", errors="replace")
    if name.startswith(LOCAL_TAG_PREFIX):
        return f"tag: {text if full else text[len(LOCAL_TAG_PREFIX) :]}"
    if full:
        return text
    if name.startswith(LOCAL_BRANCH_PREFIX):
        return text[len(LOCAL_BRANCH_PREFIX) :]
    if name.startswith(REMOTE_PREFIX):
        return text[len(REMOTE_PREFIX) :]
    return text


def _decorate_head(
    repo: BaseRepo, labels: dict[bytes, list[str]], full: bool
) -> None:
    """Prepend the HEAD label, absorbing the attached branch's own.

    Args:
        repo (BaseRepo): repository whose HEAD to read.
        labels (dict[bytes, list[str]]): per-commit labels to amend.
        full (bool): label by full ref names.
    """
    try:
        chain, sha = repo.refs.follow(HEADREF)
    except KeyError:
        return
    if sha is None:
        return
    commit = peel_to_commit(repo, sha)
    if commit is None:
        return
    names = labels.setdefault(commit.id, [])
    if len(chain) > 1:
        branch = _ref_label(chain[-1], full)
        if branch in names:
            names.remove(branch)
        names.insert(0, f"HEAD -> {branch}")
    else:
        names.insert(0, "HEAD")


def _load_commit(repo: BaseRepo, sha: bytes) -> Commit:
    """One commit by id, for a walk that only ever follows parents.

    Args:
        repo (BaseRepo): repository holding the object.
        sha (bytes): hex object id.
    """
    obj = repo.object_store[ObjectID(sha)]
    if not isinstance(obj, Commit):
        raise TypeError(
            f"{sha.decode()} is a {obj.type_name.decode()}, not a commit"
        )
    return obj


def _walk_history(
    repo: BaseRepo,
    starts: list[Commit],
    first_parent: bool,
    hidden: tuple[Commit, ...],
) -> Iterator[Commit]:
    """Walk history from a set of commits, newest first, along every
    parent.

    Ordered by committer time with ties broken by insertion, which is
    what a git log without ``--topo-order`` prints. Each commit is
    visited once however many branches reach it.

    A hidden commit takes its whole ancestry out of the walk, through
    every parent even under ``--first-parent``, which is how git carries
    a range's exclusion. With anything hidden the walk is git's limited
    one: it holds what it finds, so a commit that a later hidden one
    turns out to reach still drops out, and it runs past the point
    where every queued commit is hidden by git's slop of five hidden
    commits, restarted whenever one is dated no older than the last
    shown one. That slack is what keeps a history whose dates run
    backwards from leaking commits the hidden side reaches late.
    Synchronous, for a worker thread.

    Args:
        repo (BaseRepo): repository to walk.
        starts (list[Commit]): the commits to walk back from.
        first_parent (bool): ``--first-parent``.
        hidden (tuple[Commit, ...]): commits whose whole history is
            left out, the ``A`` of ``A..B``.
    """
    seen: set[bytes] = set()
    excluded: set[bytes] = set()
    visited: dict[bytes, Commit] = {}
    queue: list[Commit] = []
    held: list[Commit] = []

    def hide(shas: Iterable[bytes]) -> None:
        stack = list(shas)
        while stack:
            sha = stack.pop()
            if sha in excluded:
                continue
            excluded.add(sha)
            known = visited.get(sha)
            if known is not None:
                stack.extend(known.parents)
            elif sha not in seen:
                seen.add(sha)
                queue.append(_load_commit(repo, sha))

    for commit in hidden:
        if commit.id not in seen:
            seen.add(commit.id)
            excluded.add(commit.id)
            queue.append(commit)
    for commit in starts:
        if commit.id not in seen:
            seen.add(commit.id)
            queue.append(commit)
    limited = bool(hidden)
    slop = SLOP
    date = math.inf
    while queue:
        queue.sort(key=lambda commit: -commit.commit_time)
        commit = queue.pop(0)
        visited[commit.id] = commit
        if commit.id in excluded:
            hide(commit.parents)
            if not queue:
                break
            newest = max(queued.commit_time for queued in queue)
            if date <= newest or any(
                queued.id not in excluded for queued in queue
            ):
                slop = SLOP
            else:
                slop -= 1
            if slop == 0:
                break
            continue
        date = commit.commit_time
        if limited:
            held.append(commit)
        else:
            yield commit
        for parent in commit.parents[:1] if first_parent else commit.parents:
            if parent not in seen:
                seen.add(parent)
                queue.append(_load_commit(repo, parent))
    yield from (commit for commit in held if commit.id not in excluded)


def _sort_commits(
    commits: list[Commit], order: Literal["topo", "date"]
) -> list[Commit]:
    """Order a walk's commits so no parent comes before any of its
    children.

    git's sort_in_topological_order: a commit is emitted once every child
    in the list has been, children counted only among the commits listed.
    ``topo`` keeps a stack, so a merge's second parent's line is followed
    to its end before the first parent's, and the tips come out in walk
    order; ``date`` takes the newest ready commit instead, ties in the
    order they became ready.

    Args:
        commits (list[Commit]): the walk, newest first.
        order (str): which of git's two orders.
    """
    indegree: dict[bytes, int] = {commit.id: 1 for commit in commits}
    by_id: dict[bytes, Commit] = {commit.id: commit for commit in commits}
    for commit in commits:
        for parent in commit.parents:
            if indegree.get(parent, 0) > 0:
                indegree[parent] += 1
    stack: list[Commit] = []
    heap: list[tuple[int, int, bytes]] = []
    seq = 0

    def put(commit: Commit) -> None:
        nonlocal seq
        if order == "topo":
            stack.append(commit)
        else:
            heapq.heappush(heap, (-commit.commit_time, seq, commit.id))
        seq += 1

    def take() -> Commit | None:
        if order == "topo":
            return stack.pop() if stack else None
        return by_id[heapq.heappop(heap)[2]] if heap else None

    for tip in commits:
        if indegree[tip.id] == 1:
            put(tip)
    # The tips come out in the order the walk found them, which a stack
    # reverses unless it is turned over first.
    stack.reverse()
    ordered: list[Commit] = []
    ready = take()
    while ready is not None:
        for parent in ready.parents:
            count = indegree.get(parent, 0)
            if count == 0:
                continue
            indegree[parent] = count - 1
            if count - 1 == 1:
                put(by_id[parent])
        indegree[ready.id] = 0
        ordered.append(ready)
        ready = take()
    return ordered


def _in_window(commit: Commit, flags: LogFlags) -> bool:
    """Whether a commit's date is inside ``--since``/``--until``.

    Args:
        commit (Commit): the commit.
        flags (LogFlags): the parsed invocation.
    """
    if flags.since is not None and commit.commit_time < flags.since:
        return False
    return flags.until is None or commit.commit_time <= flags.until


def _message_matches(
    message: bytes, greps: tuple[re.Pattern[str], ...]
) -> bool:
    """Whether a ``--grep`` pattern matches the message.

    git searches the message a line at a time, so ``^`` and ``$`` anchor
    to a line, and never the author or committer header.

    Args:
        message (bytes): the commit message.
        greps (tuple[re.Pattern[str], ...]): the ``--grep`` patterns.
    """
    lines = message.decode("utf-8", "replace").split("\n")
    return any(pattern.search(line) for pattern in greps for line in lines)


def _ident_matches(
    ident: bytes,
    patterns: tuple[re.Pattern[str], ...],
    mailmap: tuple[MailmapEntry, ...],
) -> bool:
    """Whether an ``--author`` or ``--committer`` pattern matches.

    Args:
        ident (bytes): the recorded ``Name <email>``.
        patterns (tuple[re.Pattern[str], ...]): the alternatives.
        mailmap (tuple[MailmapEntry, ...]): the entries that map the
            identity first, empty under ``--no-mailmap``.
    """
    mapped = mapped_identity(ident.decode("utf-8", "replace"), mailmap)
    return any(pattern.search(mapped) for pattern in patterns)


def _filters_pass(commit: Commit, flags: LogFlags) -> bool:
    """Whether a commit passes ``--author``, ``--grep``, ``--merges``,
    ``--no-merges`` and kin.

    Several ``--author``s or several ``--grep``s are alternatives, while
    an ``--author`` and a ``--grep`` must both match.

    Args:
        commit (Commit): the commit.
        flags (LogFlags): the parsed invocation.
    """
    mailmap = flags.mailmap if flags.use_mailmap else ()
    for ident, patterns in (
        (commit.author, flags.authors),
        (commit.committer, flags.committers),
    ):
        if patterns and not _ident_matches(ident, patterns, mailmap):
            return False
    if flags.greps and not _message_matches(commit.message, flags.greps):
        return False
    count = len(commit.parents)
    if flags.min_parents is not None and count < flags.min_parents:
        return False
    return not (
        flags.max_parents is not None
        and flags.max_parents >= 0
        and count > flags.max_parents
    )


def walked(
    repo: BaseRepo,
    starts: list[Commit],
    flags: LogFlags,
    hidden: tuple[Commit, ...] = (),
) -> Walk:
    """The commits a log walks, in the order it walks them.

    Order of operations is git's: walk history, drop what the filters
    reject, and cut at ``-n`` printed commits. A topological or date
    order needs the whole walk first (git's limited walk), and is taken
    over the commits inside the date window before the other filters
    run. The pickaxe is the one filter that leaves a commit in the walk:
    git still draws it into the graph and only declines to print it,
    which is why ``--graph -S`` shows ``...`` rows.

    ``-n`` cannot be pushed into the walker when a pickaxe is active,
    because the limit counts commits that survive the filter, not
    commits visited.

    Args:
        repo (BaseRepo): repository to walk.
        starts (list[Commit]): the commits to walk back from; more than
            one when ``--all`` seeds every ref.
        flags (LogFlags): the parsed invocation.
        hidden (tuple[Commit, ...]): commits whose whole history is
            left out, the ``A`` of ``A..B``.
    """
    store = repo.object_store
    needle = flags.search.encode() if flags.search is not None else None
    if flags.max_count == 0:
        return Walk((), frozenset())
    source: Iterator[Commit] = (
        commit
        for commit in _walk_history(repo, starts, flags.first_parent, hidden)
        if _in_window(commit, flags)
    )
    interesting: frozenset[bytes] = frozenset()
    if flags.order != "default":
        window = list(source)
        interesting = frozenset(
            commit.id for commit in window if _filters_pass(commit, flags)
        )
        source = iter(_sort_commits(window, flags.order))
    steps: list[WalkStep] = []
    printed = 0
    for commit in source:
        if not _filters_pass(commit, flags):
            continue
        shown = needle is None or touches(
            store, commit, needle, flags.ignore_case
        )
        steps.append(WalkStep(commit, shown))
        printed += shown
        if flags.max_count is not None and printed >= flags.max_count:
            break
    return Walk(tuple(steps), interesting)


def select(
    repo: BaseRepo,
    starts: list[Commit],
    flags: LogFlags,
    hidden: tuple[Commit, ...] = (),
) -> list[Commit]:
    """The commits a log invocation prints, in the order it prints them.

    The walk's printed commits, reversed last when asked: reversing
    after the cut is what makes ``-S <name> --reverse`` name the commit
    that introduced a string rather than the most recent one to touch
    it.

    Args:
        repo (BaseRepo): repository to walk.
        starts (list[Commit]): the commits to walk back from.
        flags (LogFlags): the parsed invocation.
        hidden (tuple[Commit, ...]): commits whose whole history is
            left out, the ``A`` of ``A..B``.
    """
    selected = [
        step.commit
        for step in walked(repo, starts, flags, hidden).steps
        if step.shown
    ]
    if flags.reverse:
        selected.reverse()
    return selected
