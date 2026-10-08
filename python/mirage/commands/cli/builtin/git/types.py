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

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import tzinfo
from enum import StrEnum

from dulwich.index import ConflictedIndexEntry, IndexEntry

from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.types import CLIInvocation
from mirage.types import FileStat, PathSpec
from mirage.view.types import NamespaceView


@dataclass(frozen=True, slots=True)
class MailmapEntry:
    """One ``.mailmap`` line: the identity it matches and what it maps to.

    Args:
        email (str): the recorded email it matches, lowercased.
        name (str | None): the recorded name it also requires,
            lowercased; None for an entry that matches the email alone.
        mapped_name (str | None): the canonical name, None to keep the
            recorded one.
        mapped_email (str | None): the canonical email, None to keep
            the recorded one.
    """

    email: str
    name: str | None
    mapped_name: str | None
    mapped_email: str | None


@dataclass(frozen=True, slots=True)
class RepoLocation:
    """A resolved repository: where the objects live, and over what.

    ``gitdir`` and ``worktree`` are separate for the same reason they are
    in git: the two need not be nested, and a bare repository has no
    worktree at all.

    ``commondir`` is the third: a linked worktree (``git worktree add``)
    gets its own gitdir holding HEAD and the index, while the object
    database, packed-refs and branches stay in the repository it was cut
    from. The two are the same directory for an ordinary checkout, which
    is why one field carried both until worktrees turned up.

    Args:
        gitdir (PathSpec): absolute virtual path of this checkout's git
            directory, which holds HEAD and the index.
        commondir (PathSpec): absolute virtual path of the shared git
            directory, which holds objects and branches. Equal to
            ``gitdir`` unless this is a linked worktree.
        worktree (PathSpec): absolute virtual path of the working tree root.
        mount_root (PathSpec): the mount prefix both live under, which
            bounded the discovery walk.
        ns (NamespaceView | None): session namespace for repository entry views.
    """

    gitdir: PathSpec
    commondir: PathSpec
    worktree: PathSpec
    mount_root: PathSpec
    ns: NamespaceView | None = None


# git's refusal for a verb a read-only mount turned down, built from the
# line and the repository it opened, None when it opened none.
ReadOnlyRefusal = Callable[
    [CLIInvocation[None], RepoLocation | None], GitError
]


@dataclass(frozen=True, slots=True)
class HeadRef:
    """What HEAD points at: a branch, some other ref, or a raw commit.

    Args:
        branch (str | None): short branch name when HEAD is a symbolic
            ref under ``refs/heads``, None when detached.
        ref (str | None): the full ref name HEAD names, None when
            detached.
        commit (str | None): the object id HEAD holds directly, set only
            on a detached HEAD.
    """

    branch: str | None
    ref: str | None
    commit: str | None


@dataclass(frozen=True, slots=True)
class Upstream:
    """A branch's configured upstream, and how far the two have moved.

    Args:
        label (str): the upstream as git names it, ``origin/main`` or a
            local branch.
        ahead (int): commits on the branch the upstream lacks.
        behind (int): commits on the upstream the branch lacks.
        gone (bool): the upstream ref is configured but missing.
    """

    label: str
    ahead: int
    behind: int
    gone: bool


class Track(StrEnum):
    """``branch.autoSetupMerge``: the start points that give an upstream.

    Each member is spelled as the config value that picks it: ``true``
    takes a remote-tracking start point, ``always`` a local branch too,
    ``simple`` a remote one of the same name, ``inherit`` copies the
    start branch's own upstream, and ``false`` takes none.
    """

    OFF = "false"
    REMOTE = "true"
    ALWAYS = "always"
    SIMPLE = "simple"
    INHERIT = "inherit"


@dataclass(frozen=True, slots=True)
class HeadMove:
    """What moving HEAD carried across, and what it could not do.

    Two things rather than one because git writes both: the paths whose
    uncommitted change survived the move go to stdout with their status
    letters, and a submodule directory the move could not remove is a
    warning on stderr above the line saying the branch changed.

    Args:
        carried (dict[str, str]): each path whose uncommitted change was
            carried across, against the status letter git prints for it.
        warnings (str): the warning lines to write before the note,
            empty when there are none.
    """

    carried: dict[str, str]
    warnings: str


@dataclass(frozen=True, slots=True)
class AncestryStep:
    """One ``~`` or ``^`` suffix of a revision.

    Args:
        first_parent (bool): True for ``~n`` (walk n generations along
            first parents), False for ``^n`` (take the n-th parent).
        count (int): the number after the suffix, 1 when it was bare.
    """

    first_parent: bool
    count: int


@dataclass(frozen=True, slots=True)
class PeelStep:
    """One ``^{<type>}`` suffix of a revision.

    Args:
        want (str): the type word inside the braces, empty for ``^{}``.
    """

    want: str


RevOp = AncestryStep | PeelStep


@dataclass(frozen=True, slots=True)
class IndexState:
    """What ``.git/index`` says, split by whether a path is in conflict.

    Conflicted paths are carried apart rather than dropped, because a
    dropped one reads as unmodified: the file would compare equal to
    nothing and vanish from the report while git is refusing to commit
    because of it.

    Args:
        entries (dict[bytes, IndexEntry]): staged content, keyed by
            repository-relative path.
        conflicts (dict[bytes, ConflictedIndexEntry]): paths left
            unmerged, each holding whichever of the three stages exist.
        merging (bool): whether ``MERGE_HEAD`` is present, which is what
            distinguishes a merge in progress from its leftovers.
    """

    entries: dict[bytes, IndexEntry]
    conflicts: dict[bytes, ConflictedIndexEntry]
    merging: bool


@dataclass(frozen=True, slots=True)
class StatusEntry:
    """One path's status, in the two columns git reports it in.

    The pair is git's own model, not a convenience: the left column is
    HEAD against the index and the right is the index against the
    working tree, so a file edited, staged, then edited again is ``MM``
    and appears in both sections of the long format. Collapsing the two
    into one verdict is what makes a status report unable to say that.

    Args:
        path (str): repository-relative path.
        index_status (str): the left column, one character.
        tree_status (str): the right column, one character.
        original (str | None): the path renamed from, set only for
            ``R``.
    """

    path: str
    index_status: str
    tree_status: str
    original: str | None = None


@dataclass(frozen=True, slots=True)
class WorkTree:
    """What one walk of the working tree found.

    Args:
        files (dict[str, FileStat]): every non-ignored file that is not
            under an untracked collapsed directory, mapped to what the
            mount said about it. The whole stat is kept rather than the
            size alone because the comparison reads the mode too, and
            the walk has already paid for it.
        untracked (list[str]): paths to report as untracked, already
            collapsed to ``dir/`` where git would collapse them.
    """

    files: dict[str, FileStat] = field(default_factory=dict)
    untracked: list[str] = field(default_factory=list)
    ignored: list[str] = field(default_factory=list)


class DateKind(StrEnum):
    """One of git's date styles, spelled as ``--date`` names it."""

    NORMAL = "default"
    RELATIVE = "relative"
    SHORT = "short"
    ISO8601 = "iso8601"
    ISO8601_STRICT = "iso8601-strict"
    RFC2822 = "rfc2822"
    HUMAN = "human"
    RAW = "raw"
    UNIX = "unix"
    STRFTIME = "format"


@dataclass(frozen=True, slots=True)
class DateMode:
    """A parsed ``--date`` value, with the clock it is rendered against.

    Args:
        kind (DateKind): the style.
        local (bool): the ``-local`` suffix: show the time in the
            session's zone rather than in the one the date carries.
        strftime (str): the ``format:`` template, empty otherwise.
        now (int): the moment ``relative`` and ``human`` count from, in
            epoch seconds, read once per invocation.
        zone (tzinfo | None): the session's ``TZ``, None for the host's
            own zone, which is what a ``-local`` style shows.
    """

    kind: DateKind = DateKind.NORMAL
    local: bool = False
    strftime: str = ""
    now: int = 0
    zone: tzinfo | None = None


@dataclass(frozen=True, slots=True)
class SymbolicEnd:
    """Where a chain of symbolic refs ends.

    Args:
        name (str): the last name reached.
        symbolic (bool): whether any hop was symbolic.
    """

    name: str
    symbolic: bool


class Decoration(StrEnum):
    """How ``log`` and ``show`` label a commit with the refs that point
    at it, git's decoration style: not at all, by short names, or by
    full ref names."""

    NONE = "no"
    SHORT = "short"
    FULL = "full"


class FieldCompare(StrEnum):
    """How a ref field sorts, git's ``cmp_type``: as text, or by the
    number behind it."""

    TEXT = "text"
    NUMBER = "number"
    TIME = "time"


class FieldSource(StrEnum):
    """Where a ref field's value comes from, git's ``info_source``: the
    ref alone, the object's content, or its type and size."""

    REF = "ref"
    OBJECT = "object"
    OBJECT_INFO = "object-info"


class QuoteStyle(StrEnum):
    """``--shell``, ``--perl``, ``--python`` and ``--tcl``: how each
    field is quoted in a listing."""

    NONE = "none"
    SHELL = "shell"
    PERL = "perl"
    PYTHON = "python"
    TCL = "tcl"


class RefKind(StrEnum):
    """Which part of the namespace a listed ref lives in."""

    BRANCH = "branch"
    REMOTE = "remote"
    TAG = "tag"
    DETACHED = "detached"
    ROOT = "root"
    OTHER = "other"


@dataclass(frozen=True, slots=True)
class RefField:
    """One ``%(...)`` field of a ref format or a sort key, parsed.

    Args:
        name (str): the field as typed, its ``*`` and arguments
            included; two fields spelled alike are one field.
        field (str): the field's own name, e.g. ``refname``.
        deref (bool): the ``*`` prefix: read the object a tag peels to.
        arg (str | None): the text after the first ``:``, None when
            there is none or it is empty.
        compare (FieldCompare): how the field sorts.
        source (FieldSource): what the field is read from.
        option (str): the argument the field's parser settled on, e.g.
            ``short`` or ``lstrip``.
        number (int): the count an option carries (``lstrip=2``,
            ``short=10``, ``lines=3``, an ``align`` width).
        words (frozenset[str]): the flags a list argument set, e.g. an
            email's ``trim`` and ``mailmap``.
        text (str): an ``if`` comparand or an ``align`` position.
    """

    name: str
    field: str
    deref: bool
    arg: str | None
    compare: FieldCompare
    source: FieldSource
    option: str = ""
    number: int = 0
    words: frozenset[str] = frozenset()
    text: str = ""


@dataclass(frozen=True, slots=True)
class RefFormat:
    """A ``--format`` string, parsed once for every ref it renders.

    Args:
        pieces (tuple[str | RefField, ...]): literal text, its escapes
            already expanded, and fields, in order.
        quote (QuoteStyle): how each field is quoted.
    """

    pieces: tuple[str | RefField, ...]
    quote: QuoteStyle = QuoteStyle.NONE


@dataclass(frozen=True, slots=True)
class RefSortKey:
    """One ``--sort`` key.

    Args:
        field (RefField): the field compared.
        reverse (bool): the leading ``-``.
        version (bool): the ``version:`` (``v:``) prefix.
    """

    field: RefField
    reverse: bool = False
    version: bool = False


@dataclass(frozen=True, slots=True)
class RefObject:
    """An object as ref fields read it: its id, type and content.

    Args:
        oid (str): the hex object id.
        type (str): ``commit``, ``tag``, ``tree`` or ``blob``.
        raw (bytes): the object's content, headers and all.
    """

    oid: str
    type: str
    raw: bytes


@dataclass(frozen=True, slots=True)
class RefUpstream:
    """A branch's upstream as the ``upstream`` field reads it.

    Args:
        ref (str): the remote-tracking (or local) ref it follows.
        remote (str): ``branch.<name>.remote``.
        merge (str): ``branch.<name>.merge``.
        ahead (int): commits on the branch the upstream lacks.
        behind (int): commits on the upstream the branch lacks.
        gone (bool): the upstream ref does not exist.
    """

    ref: str
    remote: str
    merge: str
    ahead: int = 0
    behind: int = 0
    gone: bool = False


@dataclass(frozen=True, slots=True)
class RefItem:
    """One listed ref, with what its fields are read from.

    Args:
        name (str): the full ref name, ``HEAD`` for a detached HEAD.
        oid (str): the object the ref resolves to.
        kind (RefKind): which part of the namespace it lives in.
        symref (str | None): the ref a symbolic ref points at.
        obj (RefObject | None): the object, when a field reads it.
        peeled (RefObject | None): what a tag peels to, when a ``*``
            field reads it.
        upstream (RefUpstream | None): a branch's upstream, when an
            ``upstream`` field reads it.
        worktree (str): the worktree a branch is checked out in.
    """

    name: str
    oid: str
    kind: RefKind
    symref: str | None = None
    obj: RefObject | None = None
    peeled: RefObject | None = None
    upstream: RefUpstream | None = None
    worktree: str = ""


@dataclass(frozen=True, slots=True)
class RefContext:
    """What a ref's fields read beyond the ref itself, once per listing.

    Args:
        known (frozenset[str]): every name that resolves, which is what
            decides whether a shortened name is ambiguous.
        strict (bool): ``core.warnAmbiguousRefs``: a short name is
            ambiguous if any other rule finds a ref under it, not only
            an earlier one.
        head (str | None): the ref HEAD resolves to, ``HEAD`` when it is
            detached, None when it names nothing.
        head_description (str): how a detached HEAD row names itself,
            e.g. ``(HEAD detached at 1a2b3c4)``.
        abbrev (int): how many hex digits a short id keeps.
        abbreviations (Mapping[str, int]): minimum unique widths for the
            object ids abbreviated by this listing.
        mailmap (tuple[MailmapEntry, ...]): for the ``mailmap`` options.
        date (DateMode): the clock date fields render by.
        suffixes (tuple[str, ...]): ``versionsort.suffix``.
    """

    known: frozenset[str] = frozenset()
    strict: bool = True
    head: str | None = None
    head_description: str = ""
    abbrev: int = 7
    abbreviations: Mapping[str, int] = field(default_factory=dict)
    mailmap: tuple[MailmapEntry, ...] = ()
    date: DateMode = DateMode()
    suffixes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class FieldValue:
    """A field's value for one ref.

    Args:
        text (str): what it renders as.
        number (int): what it sorts by when it sorts as a number.
    """

    text: str
    number: int = 0


@dataclass(slots=True)
class FormatFrame:
    """One open block while a ref format renders: the whole row, an
    ``%(align)`` or an ``%(if)``.

    Args:
        kind (str): ``root``, ``align`` or ``if``.
        opener (RefField | None): the ``align`` or ``if`` field.
        out (list[str]): what the block has rendered so far.
        then_seen (bool): an ``if`` block reached its ``%(then)``.
        satisfied (bool): what its condition came to.
        head (FormatFrame | None): for the ``%(else)`` half of an
            ``if``, the ``if`` it belongs to.
    """

    kind: str
    opener: RefField | None = None
    out: list[str] = field(default_factory=list)
    then_seen: bool = False
    satisfied: bool = False
    head: "FormatFrame | None" = None


@dataclass(frozen=True, slots=True)
class Refspec:
    """One ``[+]<src>[:<dst>]`` refspec.

    Args:
        src (str): the remote ref, or a pattern with one ``*``.
        dst (str | None): the local ref it lands in, None for
            FETCH_HEAD alone.
        force (bool): the leading ``+``, which allows a non-fast-forward.
    """

    src: str
    dst: str | None
    force: bool
