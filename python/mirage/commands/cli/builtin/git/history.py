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
import hashlib
import heapq
import itertools
import logging
import math
import re
from collections.abc import Iterable, Iterator, Mapping, Sequence, Set
from dataclasses import dataclass, field, replace
from typing import Literal, TypeAlias

import regex
from dulwich.objects import Commit, ObjectID, Tag
from dulwich.refs import (
    HEADREF,
    LOCAL_BRANCH_PREFIX,
    LOCAL_REMOTE_PREFIX,
    LOCAL_TAG_PREFIX,
)
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.constants import TEMPLATE_KINDS
from mirage.commands.cli.builtin.git.dates import date_clock, parse_date_mode
from mirage.commands.cli.builtin.git.diff_output import (
    DiffFlags,
    entries,
    shows,
)
from mirage.commands.cli.builtin.git.errors import (
    AmbiguousArgumentError,
    BadDateError,
    BadRevisionError,
    GitError,
    IncompatibleLogOptionsError,
    InvalidDecorateError,
    NoSuchPathError,
    PatternCompileError,
    RevisionAndFilenameError,
    UnrecognizedArgumentError,
    UsageError,
)
from mirage.commands.cli.builtin.git.format import (
    DEFAULT_DATE,
    MEDIUM,
    LogFormat,
    needs_decorations,
    parse_pretty,
)
from mirage.commands.cli.builtin.git.io import exists
from mirage.commands.cli.builtin.git.mailmap import (
    load_mailmap,
    mapped_identity,
    use_mailmap,
)
from mirage.commands.cli.builtin.git.pathspec import (
    absolute_operand,
    pathspec_patterns,
)
from mirage.commands.cli.builtin.git.pickaxe import Pickaxe
from mirage.commands.cli.builtin.git.repo import (
    Repo,
    config_bool,
    config_values,
)
from mirage.commands.cli.builtin.git.revparse import split_revisions
from mirage.commands.cli.builtin.git.types import (
    DateMode,
    Decoration,
    MailmapEntry,
    RepoLocation,
)
from mirage.commands.cli.builtin.git.util import (
    MARKER,
    maybe_bool,
    split_marked,
    start_point,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.rs.errors import RegexError
from mirage.rs.regex import PosixRegex, posix_regex
from mirage.shell.bytes import byte_view, decode_text, utf8_locale
from mirage.types import PathSpec
from mirage.utils.dates import iso_timestamp
from mirage.utils.posix import compile_posix_regex
from mirage.workspace.files import Files

LinePattern: TypeAlias = re.Pattern[str] | PosixRegex

logger = logging.getLogger(__name__)

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
# The diff a walk's pickaxe searches when the caller read no diff
# options: no renames paired and merges not diffed.
PLUMBING_DIFF = DiffFlags()


@dataclass(frozen=True, slots=True)
class LogFlags:
    """The parsed shape of a ``git log`` invocation.

    Args:
        max_count (int | None): ``-n``/``--max-count``, how many commits
            to print; None when unlimited.
        oneline (bool): ``--oneline``, one abbreviated row per commit.
        reverse (bool): ``--reverse``, oldest first.
        pickaxe (Pickaxe | None): ``-S`` or ``-G``, None for neither.
        since (float | None): ``--since`` as an epoch second.
        until (float | None): ``--until`` as an epoch second.
        authors (tuple[LinePattern, ...]): author patterns, ORed together.
        greps (tuple[LinePattern, ...]): ``--grep`` patterns, any of
            which may match a line of the message.
        committers (tuple[LinePattern, ...]): ``--committer``
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
        boundary (bool): ``--boundary``, print the commits the walk
            stops at after the ones it shows.
        pathspecs (tuple[str, ...]): the repository-relative patterns
            the history is limited to, none for the whole tree.
        merge_diffs (bool): whether ``-m`` or ``--diff-merges`` asks
            for merges' diffs against their parents. Only then does a
            path walk keep merges' whole history; the first-parent diff
            ``--first-parent`` implies leaves it simplified (git 2.47.3).
    """

    max_count: int | None
    oneline: bool
    reverse: bool
    since: float | None
    until: float | None
    authors: tuple[LinePattern, ...] = ()
    greps: tuple[LinePattern, ...] = ()
    committers: tuple[LinePattern, ...] = ()
    mailmap: tuple[MailmapEntry, ...] = ()
    use_mailmap: bool = True
    ignore_case: bool = False
    date: DateMode = DEFAULT_DATE
    decorate: Decoration = Decoration.NONE
    all_refs: bool = False
    pretty: LogFormat = MEDIUM
    pickaxe: Pickaxe | None = None
    abbrev_commit: bool = False

    min_parents: int | None = None
    max_parents: int | None = None
    first_parent: bool = False
    graph: bool = False
    order: Literal["default", "topo", "date"] = "default"
    boundary: bool = False
    pathspecs: tuple[str, ...] = ()
    merge_diffs: bool = False


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
        boundary (tuple[Commit, ...]): the ``--boundary`` commits, in
            the order they print after the walk.
        parents (Mapping[bytes, tuple[bytes, ...]]): the parents a
            path-limited walk prints each of its commits with: under
            ``--graph`` the nearest shown commits along the history it
            kept, otherwise the ones it followed; empty when the walk is
            not limited.
    """

    steps: tuple[WalkStep, ...]
    interesting: frozenset[bytes]
    boundary: tuple[Commit, ...] = ()
    parents: Mapping[bytes, tuple[bytes, ...]] = field(default_factory=dict)


@dataclass(slots=True)
class _Trace:
    """What a walk records for ``--boundary``: every commit it took off
    its queue, hidden ones included, in that order, and the commits it
    hid.

    Args:
        popped (list[bytes]): the ids, in the order they left the queue.
        hidden (set[bytes]): the hidden ids, the walk's own set.
    """

    popped: list[bytes] = field(default_factory=list)
    hidden: set[bytes] = field(default_factory=set)


def _timestamp(value: str | None, flag: str, now: int) -> float | None:
    """Read a date flag as an epoch second, refusing what it cannot read.

    Accepts an ISO-8601 date or a bare epoch second. git accepts far
    more (``2 weeks ago``, ``yesterday``); anything else is refused here
    rather than silently ignored, which would quietly widen the window.
    An empty value is now, as git reads a date that says nothing
    (git 2.47: ``--since=`` lists no past commit).

    Args:
        value (str | None): the flag's value.
        flag (str): flag name, for error attribution.
        now (int): the invocation's clock, in epoch seconds.
    """
    if value is None:
        return None
    if value == "":
        return float(now)
    parsed = iso_timestamp(value)
    if parsed is not None:
        return parsed
    try:
        return float(value)
    except ValueError as exc:
        raise BadDateError(flag, value) from exc


def _window_end(
    fl: FlagView, names: tuple[str, str], flag: str, now: int
) -> float | None:
    """One end of the date window, from the last of its two spellings.

    ``--after`` and ``--since`` (``--before`` and ``--until``) set one
    limit, and each occurrence overwrites it, so the one typed last wins.

    Args:
        fl (FlagView): the log flags.
        names (tuple[str, str]): the two dests of the one limit.
        flag (str): flag name, for error attribution.
        now (int): the invocation's clock, in epoch seconds.
    """
    typed = fl.typed_order(*names)
    return _timestamp(fl.as_str(typed[-1]) if typed else None, flag, now)


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
    value: str, syntax: str, ignore_case: bool, origin: str, utf8: bool
) -> LinePattern:
    """One ``--grep``, ``--author`` or ``--committer`` pattern, compiled.

    ``-P`` goes to the ``regex`` engine, whose syntax is PCRE's where
    Python's ``re`` is not (``\\p{L}``, ``[[:alpha:]]``, ``\\K``), with
    ASCII escapes as PCRE2 reads them without UCP. A refusal names where
    the pattern came from and the pattern itself, as git words it;
    the reason after that is glibc's
    for a basic expression and the host engine's otherwise.

    Args:
        value (str): the pattern as typed.
        syntax (str): which of ``PATTERN_SYNTAXES`` reads it.
        ignore_case (bool): ``-i``/``--regexp-ignore-case``.
        origin (str): git's name for where the pattern came from.
        utf8 (bool): a UTF-8 locale: characters, not bytes, and case
            folded by Unicode.
    """
    try:
        if syntax == PERL_REGEXP:
            perl: re.Pattern[str] = regex.compile(
                value, regex.ASCII | (regex.IGNORECASE if ignore_case else 0)
            )
            return perl
        if syntax == FIXED_STRINGS:
            fold = re.IGNORECASE if ignore_case else 0
            return compile_posix_regex(re.escape(value), fold)
        return posix_regex(
            byte_view(value, utf8),
            syntax == EXTENDED_REGEXP,
            "posix",
            ignore_case,
            utf8,
        )
    except RegexError as exc:
        raise PatternCompileError(origin, value, exc.message) from exc
    except (re.error, regex.error) as exc:
        raise PatternCompileError(origin, value, str(exc)) from exc


def _pickaxe_pattern(value: str, ignore_case: bool, utf8: bool) -> PosixRegex:
    """A ``-G`` or ``--pickaxe-regex`` pattern, compiled as git's
    diffcore-pickaxe compiles it: POSIX extended whatever -E, -F or -P
    say, ``-i`` folding case, and matched one line at a time
    (REG_NEWLINE). Linux regcomp keeps dot off NUL, unlike Darwin.

    Args:
        value (str): the pattern as typed.
        ignore_case (bool): ``-i``/``--regexp-ignore-case``.
        utf8 (bool): a UTF-8 locale.
    """
    try:
        return posix_regex(
            byte_view(value, utf8), True, "posix", ignore_case, utf8, True
        )
    except RegexError as exc:
        raise GitError(f"invalid regex: {exc.message}") from exc


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
    utf8 = utf8_locale(env)
    syntax = BASIC_REGEXP
    for key, _ in fl.occurrences(*PATTERN_SYNTAXES):
        syntax = key
    committers = tuple(
        _pattern(value, syntax, ignore_case, HEADER_ORIGIN, utf8)
        for value in fl.as_list("committer")
    )
    authors = tuple(
        _pattern(value, syntax, ignore_case, HEADER_ORIGIN, utf8)
        for value in fl.as_list("author")
    )
    greps = tuple(
        _pattern(value, syntax, ignore_case, COMMAND_LINE_ORIGIN, utf8)
        for values in fl.as_list("grep")
        for value in values.split("\n")
    )
    search = fl.as_str("S")
    changed = fl.as_str("G")
    for option, value in (("-S", search), ("-G", changed)):
        if value == "":
            raise UsageError(
                "", f"error: {option} requires a non-empty argument\n"
            )
    if search is not None and changed is not None:
        raise IncompatibleLogOptionsError("-G", "-S", "--find-object")
    pickaxe = None
    if search is not None or changed is not None:
        needle: bytes | PosixRegex | None = None
        if isinstance(search, str):
            needle = (
                _pickaxe_pattern(search, ignore_case, utf8)
                if fl.as_bool("pickaxe_regex")
                else search.encode()
            )
        pickaxe = Pickaxe(
            needle=needle,
            changed=None
            if changed is None
            else _pickaxe_pattern(changed, ignore_case, utf8),
            ignore_case=ignore_case,
            force_text=fl.as_bool("text"),
            every=fl.as_bool("pickaxe_all"),
        )
    max_count = fl.as_int("max_count")
    clock = date_clock(env)
    return LogFlags(
        authors=authors,
        committers=committers,
        greps=greps,
        ignore_case=ignore_case,
        date=parse_date_mode(fl.as_str("date", "default"), clock),
        # git reads a negative count as no limit at all.
        max_count=None
        if max_count is not None and max_count < 0
        else max_count,
        min_parents=2 if fl.as_bool("merges") else fl.as_int("min_parents"),
        max_parents=1 if fl.as_bool("no_merges") else fl.as_int("max_parents"),
        first_parent=fl.as_bool("first_parent"),
        oneline=oneline,
        reverse=fl.as_bool("reverse"),
        pickaxe=pickaxe,
        since=_window_end(fl, ("after", "since"), "--since", clock.now),
        until=_window_end(fl, ("before", "until"), "--until", clock.now),
        all_refs=fl.as_bool("all"),
        pretty=pretty,
        abbrev_commit=oneline,
        graph=graph,
        order=order,
        boundary=fl.as_bool("boundary"),
        merge_diffs=fl.as_bool("m")
        or fl.as_str("diff_merges", "off") in PARENT_DIFFS,
    )


# The ``--diff-merges`` values that diff a merge against its parents, one
# by one or the first alone.
PARENT_DIFFS = frozenset(("on", "1", "m", "separate", "first-parent"))

# What makes an operand a pattern git reads as a path unseen.
WILDCARDS = "*?[\\"


async def walk_operands(
    ctx: Context,
    fl: FlagView,
    repo: BaseRepo,
    location: RepoLocation,
    texts: Sequence[str],
) -> tuple[tuple[str, ...], tuple[str, ...], bool]:
    """A walk's operands as revisions and the patterns of the paths it is
    limited to, and whether ``--`` was on the line; see ``_operands``.

    Args:
        ctx (Context): the line's context, carrying its argv.
        fl (FlagView): the verb's flags, for ``-C``.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): where it was discovered.
        texts (Sequence[str]): the operands.
    """
    start = start_point(fl).virtual
    leading, marked = split_marked(tuple(texts), ctx.argv)
    dashed = MARKER in ctx.argv
    present = (
        frozenset()
        if dashed or ctx.vfs is None
        else await _present_operands(ctx.vfs, start, leading)
    )
    revisions, paths = await asyncio.to_thread(
        _operands, repo, leading, dashed, present
    )
    return (
        revisions,
        pathspec_patterns(location, start, (*paths, *marked)),
        dashed,
    )


def walk_ends(
    repo: BaseRepo, revisions: tuple[str, ...], dashed: bool
) -> tuple[list[Commit], list[Commit]]:
    """The commits a walk starts from and hides, as ``split_revisions``
    reads them, except that with ``--`` on the line a revision that
    resolves to nothing is a bad revision (git 2.47.3).

    Args:
        repo (BaseRepo): the opened repository.
        revisions (tuple[str, ...]): the revision operands.
        dashed (bool): whether ``--`` is on the line.
    """
    try:
        return split_revisions(repo, revisions)
    except AmbiguousArgumentError as exc:
        if not dashed:
            raise
        raise BadRevisionError(exc.revision) from exc


async def _present_operands(
    vfs: Files, start: str, texts: Sequence[str]
) -> frozenset[str]:
    """The operands that name something in the working tree, as git
    looks before it reads an operand as a path.

    Args:
        vfs (Files): the session's files.
        start (str): absolute virtual path git is running in.
        texts (Sequence[str]): the operands.
    """
    found = set()
    for text in texts:
        where = PathSpec.from_str_path(absolute_operand(start, text))
        if text and await exists(vfs, where):
            found.add(text)
    return frozenset(found)


def _operands(
    repo: BaseRepo,
    leading: tuple[str, ...],
    dashed: bool,
    present: frozenset[str],
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Split the operands before any ``--`` into revisions and paths.

    With ``--`` on the line they are all revisions. Without it each is a
    revision while it resolves as one, and one that also names a file is
    refused as ambiguous; the first that does not resolve starts the
    paths, which then have to name something in the working tree, as
    every later operand does, unless it is a wildcard pattern (git
    2.47.3). Synchronous, for a worker thread: resolving reads objects.

    Args:
        repo (BaseRepo): the opened repository.
        leading (tuple[str, ...]): the operands before any ``--``.
        dashed (bool): whether ``--`` is on the line.
        present (frozenset[str]): the operands that name a file.
    """
    if dashed:
        return leading, ()
    for index, text in enumerate(leading):
        if not _resolves(repo, text):
            if text not in present and not _wildcard(text):
                raise AmbiguousArgumentError(text)
            for later in leading[index + 1 :]:
                if later not in present and not _wildcard(later):
                    raise NoSuchPathError(later)
            return leading[:index], leading[index:]
        if text in present:
            raise RevisionAndFilenameError(text)
    return leading, ()


def _resolves(repo: BaseRepo, text: str) -> bool:
    """Whether an operand resolves as a revision, the warnings resolving
    it gives left to the walk, which resolves it again.

    Args:
        repo (BaseRepo): the opened repository.
        text (str): the operand.
    """
    warnings = repo.ambiguous if isinstance(repo, Repo) else None
    kept = 0 if warnings is None else len(warnings)
    try:
        split_revisions(repo, (text,))
    except AmbiguousArgumentError:
        return False
    finally:
        if warnings is not None:
            del warnings[kept:]
    return True


def _wildcard(text: str) -> bool:
    """Whether an operand is a pattern, which git takes as a path without
    looking for it in the working tree.

    Args:
        text (str): the operand.
    """
    return any(char in text for char in WILDCARDS)


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
        except KeyError as exc:
            # A symref to an unborn branch names nothing yet.
            logger.debug("ref %r names no commit yet: %s", name, exc)
            continue
        commit = peel_to_commit(repo, sha)
        if commit is not None:
            commits.append(commit)
    return commits


def decoration_style(value: bytes) -> Decoration | None:
    """The decoration style a value names, None for none.

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
    vfs: Files,
    location: RepoLocation,
    fl: FlagView,
    pretty: LogFormat,
) -> Decoration:
    """How a ``log`` or ``show`` line labels its commits.

    As git settles it (pinned against git 2.47.3): ``log.decorate`` sets
    the style, a value it cannot read meaning none, and the line's
    ``--decorate[=<style>]`` and ``--no-decorate`` override it, the last
    one typed winning; ``--pretty=raw`` ignores the config. A template
    that prints ``%d`` or ``%D`` is decorated even when nothing asked,
    by short names unless a style says full, and one that prints neither
    loads no labels at all.

    Args:
        vfs (Files): the session's files.
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
        configured = await config_values(vfs, location, b"log", b"decorate")
        if configured:
            style = decoration_style(configured[-1])
    if style is None:
        style = Decoration.NONE
    if pretty.kind not in TEMPLATE_KINDS:
        return style
    if not needs_decorations(pretty):
        return Decoration.NONE
    return Decoration.SHORT if style is Decoration.NONE else style


async def displayed(
    vfs: Files,
    location: RepoLocation,
    fl: FlagView,
    pretty: LogFormat,
) -> tuple[tuple[MailmapEntry, ...], bool, Decoration]:
    """How ``log`` and ``show`` present commits, once the repository's
    config can be read: the worktree ``.mailmap``, whether the header
    identities map through it (``log.mailmap`` unless the line's
    ``--[no-]mailmap`` says otherwise), and the decoration style.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the discovered repository.
        fl (FlagView): the line's flags.
        pretty (LogFormat): the line's format.

    Raises:
        BadConfigValueError: a ``log.mailmap`` git cannot read as a
            boolean.
        InvalidDecorateError: a ``--decorate`` value that names no style.
    """
    return (
        await load_mailmap(vfs, location),
        use_mailmap(
            fl, await config_bool(vfs, location, b"log", b"mailmap", True)
        ),
        await decoration_for(vfs, location, fl, pretty),
    )


def decorations(
    repo: BaseRepo, style: Decoration = Decoration.SHORT
) -> dict[bytes, list[str]] | None:
    """Ref labels per commit, in the order git prints them; None for a
    line that prints none.

    git walks refs alphabetically and prepends each label, so a
    commit's labels read in reverse ref order; HEAD is pulled to the
    front, spelled ``HEAD -> branch`` when attached (the branch's own
    label is absorbed) and ``HEAD`` alone when detached. Pinned against
    git 2.50.

    Args:
        repo (BaseRepo): repository whose refs to enumerate.
        style (Decoration): ``FULL`` keeps each ref's whole name,
            ``NONE`` loads nothing; anything else shortens it.
    """
    if style is Decoration.NONE:
        return None
    full = style is Decoration.FULL
    labels: dict[bytes, list[str]] = {}
    for name in sorted(repo.refs.allkeys()):
        if name == HEADREF:
            continue
        try:
            sha = repo.refs[name]
        except KeyError as exc:
            logger.debug("ref %r names no commit yet: %s", name, exc)
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
    if name.startswith(LOCAL_REMOTE_PREFIX):
        return text[len(LOCAL_REMOTE_PREFIX) :]
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


class _Simplifier:
    """git's default history simplification, for a walk limited to paths.

    A commit is shown when it is not TREESAME to its parents, its tree
    and theirs holding the same entries at the paths: a root when the
    paths hold anything, a commit with one parent when it changed them,
    and a merge only when no parent is TREESAME to it. A merge TREESAME
    to a parent leads on to the first such parent alone, so history the
    paths came by some other way drops out. A parent the walk hid on its
    way down does not count, while one it was told to hide (``^A``, a
    range's left end, the merge base of ``A...B``) does (git 2.47.3).
    When merges are diffed
    against each parent (``-m``, ``--diff-merges=first-parent``) git
    keeps their whole history instead: a merge leads on to every parent
    and is shown when it differs from any of them, or always where
    ``--graph`` draws the history.

    Args:
        repo (BaseRepo): repository holding the commits.
        patterns (tuple[str, ...]): repository-relative patterns.
        full (bool): keep merges' whole history.
        graph (bool): ``--graph``.
        bottoms (frozenset[bytes]): the commits the walk was told to
            hide.
    """

    def __init__(
        self,
        repo: BaseRepo,
        patterns: tuple[str, ...],
        full: bool = False,
        graph: bool = False,
        bottoms: frozenset[bytes] = frozenset(),
    ) -> None:
        self._repo = repo
        self._patterns = patterns
        self._full = full
        self._graph = graph
        self._bottoms = bottoms
        self._views: dict[bytes, bytes | None] = {}
        self._nearest: dict[bytes, tuple[bytes, ...]] = {}
        self._hidden: Set[bytes] = frozenset()
        self.followed: dict[bytes, tuple[bytes, ...]] = {}
        self.shown: dict[bytes, bool] = {}

    def _view(self, sha: bytes) -> bytes | None:
        """A digest of the entries one commit holds at the paths, None
        when they hold nothing.

        The walk only asks whether two commits hold the same entries, so
        only the digest is kept, and a path log over a long history does
        not hold every file at every commit.

        Args:
            sha (bytes): the commit id.
        """
        if sha not in self._views:
            held = entries(
                self._repo,
                _load_commit(self._repo, sha).tree,
                True,
                self._patterns,
            )
            self._views[sha] = (
                hashlib.sha1(
                    b"".join(
                        b"%o %s\0%s" % (mode, path, oid)
                        for path, (mode, oid) in sorted(held.items())
                    ),
                    usedforsecurity=False,
                ).digest()
                if held
                else None
            )
        return self._views[sha]

    def follow(
        self, commit: Commit, parents: Sequence[bytes], hidden: Set[bytes]
    ) -> list[bytes]:
        """Settle whether a walked commit is shown, and the parents it
        leads on to.

        Args:
            commit (Commit): the commit, just taken off the queue.
            parents (Sequence[bytes]): the parents the walk would follow.
            hidden (Set[bytes]): the commits hidden so far.
        """
        self._hidden = hidden
        mine = self._view(commit.id)
        followed = list(parents)
        if not commit.parents:
            shown = mine is not None
        elif len(commit.parents) == 1:
            shown = mine != self._view(commit.parents[0])
        elif self._full:
            shown = self._graph or any(
                self._view(parent) != mine for parent in parents
            )
        else:
            same = next(
                (
                    parent
                    for parent in parents
                    if (parent not in hidden or parent in self._bottoms)
                    and self._view(parent) == mine
                ),
                None,
            )
            shown = same is None
            if same is not None:
                followed = [same]
        self.shown[commit.id] = shown
        self.followed[commit.id] = tuple(followed)
        return followed

    def rewritten(self, commit: Commit) -> tuple[bytes, ...]:
        """A shown commit's parents as ``--graph`` sees them: each followed
        parent, or the nearest shown commits it leads on to when it is
        not shown itself, a hidden one standing for itself.

        Args:
            commit (Commit): a shown commit.
        """
        out: dict[bytes, None] = {}
        for parent in self.followed.get(commit.id, ()):
            out.update(dict.fromkeys(self._shown_below(parent)))
        return tuple(out)

    def _known(self, sha: bytes) -> tuple[bytes, ...] | None:
        """The nearest shown commits at or below one, None while they are
        not worked out yet.

        Args:
            sha (bytes): the commit id.
        """
        if self.shown.get(sha) or sha in self._hidden:
            return (sha,)
        if sha not in self.followed:
            return ()
        return self._nearest.get(sha)

    def _shown_below(self, sha: bytes) -> tuple[bytes, ...]:
        """The nearest shown commits at or below one the walk followed,
        itself when it is shown.

        Worked out from the bottom on a stack of its own, since a path
        can go unchanged for longer than the interpreter can recurse.

        Args:
            sha (bytes): the commit id.
        """
        stack = [sha]
        while stack:
            top = stack[-1]
            if self._known(top) is not None:
                stack.pop()
                continue
            waiting = [p for p in self.followed[top] if self._known(p) is None]
            if waiting:
                stack.extend(reversed(waiting))
                continue
            out: dict[bytes, None] = {}
            for parent in self.followed[top]:
                out.update(dict.fromkeys(self._known(parent) or ()))
            self._nearest[top] = tuple(out)
            stack.pop()
        return self._known(sha) or ()


def _walk_history(
    repo: BaseRepo,
    starts: list[Commit],
    first_parent: bool,
    hidden: tuple[Commit, ...],
    trace: _Trace | None = None,
    simplify: _Simplifier | None = None,
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
        trace (_Trace | None): where to record the queue's order and the
            hidden set, for ``--boundary``.
        simplify (_Simplifier | None): the path limiting that picks which
            parents a commit leads on to, None to follow them all.
    """
    seen: set[bytes] = set()
    excluded: set[bytes] = set() if trace is None else trace.hidden
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
        if trace is not None:
            trace.popped.append(commit.id)
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
        parents: Sequence[bytes] = (
            commit.parents[:1] if first_parent else commit.parents
        )
        if simplify is not None:
            parents = simplify.follow(commit, parents, excluded)
        if limited:
            held.append(commit)
        else:
            yield commit
        for parent in parents:
            if parent not in seen:
                seen.add(parent)
                queue.append(_load_commit(repo, parent))
    yield from (commit for commit in held if commit.id not in excluded)


def _sort_commits(
    commits: list[Commit],
    order: Literal["topo", "date"],
    parents: Mapping[bytes, tuple[bytes, ...]] | None = None,
) -> list[Commit]:
    """Order a walk's commits so no parent comes before any of its
    children.

    A commit is ready once every child of it in the list is printed;
    children outside the list do not hold it back, and every parent
    counts, ``--first-parent`` or not. ``topo`` prints the commit a
    printed child made ready last before the next tip in walk order, so
    a merge's last parent's line runs to its end before an earlier
    parent's: git 2.50.1 prints ``M P2b P2a P1b P1a base`` for a merge
    ``M`` of ``P1b`` and ``P2b`` whatever their dates. ``date`` prints the
    newest ready commit, ties in the order they became ready, the tips
    first in walk order.

    Args:
        commits (list[Commit]): the walk, newest first.
        order (Literal["topo", "date"]): ``--topo-order`` or
            ``--date-order``.
        parents (Mapping[bytes, tuple[bytes, ...]] | None): the parents
            to order by, each commit's own when None.
    """

    def parents_of(commit: Commit) -> Sequence[bytes]:
        return commit.parents if parents is None else parents[commit.id]

    by_id: dict[bytes, Commit] = {commit.id: commit for commit in commits}
    unprinted_children: dict[bytes, int] = dict.fromkeys(by_id, 0)
    for listed in commits:
        for parent_id in parents_of(listed):
            if parent_id in unprinted_children:
                unprinted_children[parent_id] += 1
    tips = [c for c in commits if not unprinted_children[c.id]]
    printed: list[Commit] = []

    def print_commit(commit: Commit) -> list[Commit]:
        printed.append(commit)
        freed = []
        for parent_id in parents_of(commit):
            if parent_id in unprinted_children:
                unprinted_children[parent_id] -= 1
                if not unprinted_children[parent_id]:
                    freed.append(by_id[parent_id])
        return freed

    if order == "topo":
        freed: list[Commit] = []
        upcoming = iter(tips)
        while True:
            current = freed.pop() if freed else next(upcoming, None)
            if current is None:
                return printed
            freed.extend(print_commit(current))
    # The ready commits on a heap keyed newest first and then earliest
    # readied, so the next one to print is at its top.
    arrivals = itertools.count()
    ready = [(-tip.commit_time, next(arrivals), tip.id) for tip in tips]
    heapq.heapify(ready)
    while ready:
        for parent in print_commit(by_id[heapq.heappop(ready)[2]]):
            heapq.heappush(
                ready, (-parent.commit_time, next(arrivals), parent.id)
            )
    return printed


def _in_window(commit: Commit, flags: LogFlags) -> bool:
    """Whether a commit's date is inside ``--since``/``--until``.

    Args:
        commit (Commit): the commit.
        flags (LogFlags): the parsed invocation.
    """
    if flags.since is not None and commit.commit_time < flags.since:
        return False
    return flags.until is None or commit.commit_time <= flags.until


def _hits(pattern: LinePattern, text: str) -> bool:
    """Whether a ``--grep``, ``--author`` or ``--committer`` pattern
    matches ``text``.

    Args:
        pattern (LinePattern): the compiled pattern.
        text (str): the line or identity.
    """
    if isinstance(pattern, PosixRegex):
        return pattern.search(byte_view(text, pattern.utf8)) is not None
    return pattern.search(text) is not None


def _message_matches(message: bytes, greps: tuple[LinePattern, ...]) -> bool:
    """Whether a ``--grep`` pattern matches the message.

    git searches the message a line at a time, so ``^`` and ``$`` anchor
    to a line, and never the author or committer header.

    Args:
        message (bytes): the commit message.
        greps (tuple[LinePattern, ...]): the ``--grep`` patterns.
    """
    # A byte that is no part of a character stays itself, as git matches it.
    lines = decode_text(message).split("\n")
    return any(_hits(pattern, line) for pattern in greps for line in lines)


def _ident_matches(
    ident: bytes,
    patterns: tuple[LinePattern, ...],
    mailmap: tuple[MailmapEntry, ...],
) -> bool:
    """Whether an ``--author`` or ``--committer`` pattern matches.

    Args:
        ident (bytes): the recorded ``Name <email>``.
        patterns (tuple[LinePattern, ...]): the alternatives.
        mailmap (tuple[MailmapEntry, ...]): the entries that map the
            identity first, empty under ``--no-mailmap``.
    """
    # The map is read as text, so the identity is looked up the same way;
    # one it leaves alone is matched as its own bytes.
    text = ident.decode("utf-8", "replace")
    mapped = mapped_identity(text, mailmap)
    subject = decode_text(ident) if mapped == text else mapped
    return any(_hits(pattern, subject) for pattern in patterns)


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


def _boundary_of(
    repo: BaseRepo,
    steps: list[WalkStep],
    trace: _Trace,
    by_date: bool,
    stopped: bool,
    parents: Mapping[bytes, tuple[bytes, ...]],
) -> list[Commit]:
    """The commits ``--boundary`` prints after the walk, in git's order.

    A boundary commit is a parent, any parent, of a walked commit that
    the walk did not take itself: a hidden one, one a filter left out,
    or one past ``-n``. A pickaxe does not leave a commit out of the
    walk, so the parents of a commit it passed by count too; the paths
    do.

    Under ``--date-order`` they print newest first. Otherwise they
    follow the walk: each one leaving the queue with no boundary child
    listed goes to the front, and each listed one puts its boundary
    parents right after itself, in parent order, so a run of commits git
    reaches through one another prints together and later runs print
    first. The ones ``-n`` cut off print before them all, and the ones
    the walk never reached after, newest first (git 2.47.3; the order
    differs at times where git reaches one only through another's
    merge).

    Args:
        repo (BaseRepo): repository holding the commits.
        steps (list[WalkStep]): the walked commits.
        trace (_Trace): the walk's queue order and hidden set.
        by_date (bool): ``--date-order``.
        stopped (bool): whether ``-n`` cut the walk short.
        parents (Mapping[bytes, tuple[bytes, ...]]): the parents the
            walk prints its commits with, each commit's own when absent.
    """
    walked = {step.commit.id for step in steps}
    found: dict[bytes, Commit] = {}
    for step in steps:
        commit = step.commit
        for parent in parents.get(commit.id, tuple(commit.parents)):
            if parent not in walked and parent not in found:
                found[parent] = _load_commit(repo, parent)

    def newest(shas: Iterable[bytes]) -> list[bytes]:
        return sorted(shas, key=lambda sha: -found[sha].commit_time)

    if by_date:
        return [found[sha] for sha in newest(found)]
    last = (
        trace.popped.index(steps[-1].commit.id)
        if stopped
        else len(trace.popped)
    )
    passed = trace.popped[: last + 1]
    cut = newest(
        sha
        for sha in found
        if sha not in trace.hidden and sha not in set(passed)
    )
    listed: list[bytes] = []
    for sha in passed:
        if sha in found and sha not in cut and sha not in listed:
            listed.insert(0, sha)
        if sha not in listed:
            continue
        at = listed.index(sha)
        for parent in found[sha].parents:
            if parent in found and parent not in cut and parent not in listed:
                listed.insert(at + 1, parent)
    rest = newest(sha for sha in found if sha not in cut and sha not in listed)
    return [found[sha] for sha in (*cut, *listed, *rest)]


def walked(
    repo: BaseRepo,
    starts: list[Commit],
    flags: LogFlags,
    hidden: tuple[Commit, ...] = (),
    diff: DiffFlags = PLUMBING_DIFF,
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
        diff (DiffFlags): the diff the pickaxe searches: its renames,
            its merge diff and its paths.
    """
    if flags.max_count == 0:
        return Walk((), frozenset())
    diff = replace(diff, pickaxe=flags.pickaxe)
    trace = _Trace() if flags.boundary else None
    simplify = (
        _Simplifier(
            repo,
            flags.pathspecs,
            flags.merge_diffs and diff.merge in ("separate", "first-parent"),
            flags.graph,
            frozenset(commit.id for commit in hidden),
        )
        if flags.pathspecs
        else None
    )
    source: Iterator[Commit] = (
        commit
        for commit in _walk_history(
            repo, starts, flags.first_parent, hidden, trace, simplify
        )
        if _in_window(commit, flags)
    )
    interesting: frozenset[bytes] = frozenset()
    # The parents a path-limited walk prints its commits with: the ones
    # ``--graph`` draws, and for a merge the paths cut down to the parent
    # it follows, which only ``--boundary`` ever prints, that one parent.
    parents: dict[bytes, tuple[bytes, ...]] = {}
    if flags.order != "default":
        # The commits the paths leave out still take their place in the
        # order, merges leading only to the parent they follow; they
        # drop out after, which is where a log draws its graph from.
        window = list(source)
        if simplify is not None and flags.graph:
            parents = {
                c.id: simplify.rewritten(c)
                for c in window
                if simplify.shown[c.id]
            }
        interesting = frozenset(
            commit.id
            for commit in window
            if _filters_pass(commit, flags)
            and (simplify is None or simplify.shown[commit.id])
        )
        source = iter(
            _sort_commits(
                window,
                flags.order,
                simplify.followed if simplify is not None else None,
            )
        )
    steps: list[WalkStep] = []
    printed = 0
    for commit in source:
        if not _filters_pass(commit, flags) or (
            simplify is not None and not simplify.shown[commit.id]
        ):
            continue
        shown = shows(repo, commit, diff)
        steps.append(WalkStep(commit, shown))
        printed += shown
        if flags.max_count is not None and printed >= flags.max_count:
            break
    stopped = flags.max_count is not None and printed >= flags.max_count
    if trace is None:
        return Walk(tuple(steps), interesting, parents=parents)
    boundary = [
        commit
        for commit in _boundary_of(
            repo, steps, trace, flags.order == "date", stopped, parents
        )
        if shows(repo, commit, diff)
    ]
    if simplify is not None:
        for commit in boundary:
            if simplify.shown.get(commit.id) is False:
                parents[commit.id] = simplify.followed[commit.id]
    return Walk(
        tuple(steps),
        interesting | {commit.id for commit in boundary},
        tuple(boundary),
        parents,
    )


def select(
    repo: BaseRepo,
    starts: list[Commit],
    flags: LogFlags,
    hidden: tuple[Commit, ...] = (),
    diff: DiffFlags = PLUMBING_DIFF,
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
        diff (DiffFlags): the diff the pickaxe searches.
    """
    return in_print_order(walked(repo, starts, flags, hidden, diff), flags)


def in_print_order(walk: Walk, flags: LogFlags) -> list[Commit]:
    """The commits a walk prints, in the order it prints them: the
    shown ones, then the ``--boundary`` ones, all of them reversed
    under ``--reverse``.

    Args:
        walk (Walk): the walk.
        flags (LogFlags): the parsed invocation.
    """
    selected = [step.commit for step in walk.steps if step.shown]
    selected.extend(walk.boundary)
    if flags.reverse:
        selected.reverse()
    return selected
