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

from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from enum import Enum, StrEnum
from typing import TYPE_CHECKING, Annotated, Any, ClassVar, Protocol, TypeAlias

from pydantic import (BaseModel, ConfigDict, Field, NonNegativeInt,
                      model_validator)

if TYPE_CHECKING:
    import aiohttp

    from mirage.policy.types import CommandRule


class Aggr:
    """Declares how one Limit field aggregates across stacked limits.

    Attach to a field via Annotated[..., Aggr(rule)]; ``rule`` takes the
    list of that field's values across the stacked limits and returns
    the aggregated value. Limit.aggr reads these rules so each
    field's aggregation behavior lives next to the field.

    Args:
        reduce (Callable[[list[Any]], Any]): the per-field
            aggregation rule.
    """

    def __init__(self, reduce: Callable[[list[Any]], Any]) -> None:
        self.reduce = reduce


def _min_positive(values: Iterable[float | int | None]) -> float | int | None:
    positives = [v for v in values if v is not None and v > 0]
    return min(positives) if positives else None


class FindType(str, Enum):
    """POSIX `find -type` flag values (`-type d`, `-type f`)."""
    DIRECTORY = "d"
    FILE = "f"


class LsSortBy(str, Enum):
    """`ls` sort keys. NAME is default, TIME is `-t`, SIZE is `-S`."""
    NAME = "name"
    TIME = "time"
    SIZE = "size"


class FileType(str, Enum):
    """POSIX file type (the `st_mode` kind), the switch behavior branches on.

    One per entry, always present. Directory and symlink are their own
    kinds; every regular file is FILE and carries its content shape on
    FileStat.content. Distinct from ContentType, which is only a
    rendering hint for a FILE.

    The full POSIX set is enumerated so the model is comprehensive. Only
    DIRECTORY, FILE and SYMLINK are produced today; CHAR_DEVICE,
    BLOCK_DEVICE, FIFO and SOCKET are declared but not yet emitted, and
    the render/derivation tables (find letter, st_mode bits, ls char)
    grow a row for one the moment a backend starts producing it.
    """
    DIRECTORY = "directory"
    FILE = "file"
    SYMLINK = "symlink"
    CHAR_DEVICE = "char_device"
    BLOCK_DEVICE = "block_device"
    FIFO = "fifo"
    SOCKET = "socket"


class ContentType(str, Enum):
    """A regular file's content shape: the rendering hint (file/ls color).

    Only meaningful for a FILE; a directory or symlink carries none. Not
    a node kind -- nothing branches control flow on it.
    """
    TEXT = "text"
    BINARY = "binary"
    JSON = "json"
    CSV = "csv"
    IMAGE_PNG = "image/png"
    IMAGE_JPEG = "image/jpeg"
    IMAGE_GIF = "image/gif"
    ZIP = "application/zip"
    GZIP = "application/gzip"
    PDF = "application/pdf"


# FileStat.extra key holding a symlink's target, verbatim as it was
# typed. A link has no backend inode, so this is the only place the
# target travels with the stat row.
LINK_TARGET_KEY = "link_target"

# FileStat.extra key holding a device node's logical [major, minor]. A
# character or block device has no size; its identity is these numbers,
# which stat, ls -l, file and tar render in place of a byte length.
DEVICE_NUMBERS_KEY = "device_numbers"


class FileStat(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    size: int | None = None
    modified: str | None = None
    fingerprint: str | None = None
    revision: str | None = None
    type: FileType
    content: ContentType | None = None
    mode: int | None = None
    uid: int | str | None = None
    gid: int | str | None = None
    atime: str | None = None
    extra: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _content_only_on_file(self) -> "FileStat":
        # content is a FILE's rendering hint; a directory or symlink has
        # none. None on a FILE means "unknown", which is allowed.
        if self.type is not FileType.FILE and self.content is not None:
            raise ValueError(f"content must be None for {self.type.value}, "
                             f"got {self.content.value}")
        return self


# Any value that survives a JSON round trip: what a decoded payload
# holds, what jq evaluates over, what an API field hands back. Recursive
# on purpose -- the alternative, `object`, also admits bytes and every
# other non-JSON value, so each use site has to isinstance its way back
# to the same set. Spelled as a string because a recursive alias needs
# a forward reference until the floor is 3.12 (PEP 695 `type`), so a
# union with it has to be quoted too: `Awaitable["JsonValue | X"]`.
JsonValue: TypeAlias = ("None | bool | int | float | str | list[JsonValue]"
                        " | dict[str, JsonValue]")

# How a >= 400 API response and its body text become the backend's own
# exception; core/api/client.py's engine calls it, each backend supplies
# one. Quoted so importing mirage.types never loads aiohttp at runtime.
ErrorOf: TypeAlias = "Callable[[aiohttp.ClientResponse, str], Exception]"
# One page request of a cursor-paginated endpoint: receives the cursor to
# resume from (None for the first page) and returns the decoded reply.
PageFetch: TypeAlias = Callable[[str | None], Awaitable[dict[str, Any]]]

ReadBytesFn: TypeAlias = Callable[..., Awaitable[bytes]]
ReadStreamFn: TypeAlias = Callable[..., AsyncIterator[bytes]]
# A "polymorphic" reader is the loose `read` contract head/tail/wc
# accept: a backend may hand back materialized bytes, an awaitable of
# bytes, or an async byte stream; ensure_stream normalizes downstream.
PolymorphicReadResult: TypeAlias = (bytes | AsyncIterator[bytes]
                                    | Awaitable[bytes | AsyncIterator[bytes]])
PolymorphicReadFn: TypeAlias = Callable[..., PolymorphicReadResult]
CopyFn: TypeAlias = Callable[..., Awaitable[None]]
MoveFn: TypeAlias = Callable[..., Awaitable[None]]
FindFn: TypeAlias = Callable[..., Awaitable[list[str]]]
ReaddirFn: TypeAlias = Callable[..., Awaitable[list[str]]]
StatFn: TypeAlias = Callable[..., Awaitable["FileStat"]]


class CapacityState(StrEnum):
    """How a mount's capacity relates to a df-style report.

    QUOTA: real total/used/available numbers are known (a real disk, or a
    provider that exposes a storage quota). ELASTIC: the backend has no
    fixed size (object stores like S3 grow without a quota). NA: the
    backend has no filesystem-capacity concept (a message/table surface
    like Slack or Postgres). UNKNOWN: bounded but not cheaply measurable,
    or simply not reported yet. df renders real numbers for QUOTA and a
    literal ``-`` for the rest — never a fabricated total.
    """
    QUOTA = "quota"
    ELASTIC = "elastic"
    NA = "na"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class CapacityResult:
    """One mount's capacity for df. All byte counts are None unless the
    state is QUOTA.

    Args:
        state (CapacityState): how to interpret the numbers.
        total (int | None): total bytes.
        used (int | None): used bytes.
        available (int | None): bytes available to the workspace user.
        inodes (int | None): total inodes.
        inodes_used (int | None): used inodes.
        inodes_free (int | None): free inodes.
    """
    state: CapacityState
    total: int | None = None
    used: int | None = None
    available: int | None = None
    inodes: int | None = None
    inodes_used: int | None = None
    inodes_free: int | None = None


@dataclass(frozen=True, slots=True)
class NativeCopy:
    copy: CopyFn
    find: FindFn
    dir_copy: CopyFn | None = None
    # Lets the per-entry policy path (--update/--backup, which cannot use a
    # whole-tree dir_copy) still materialize directories that hold no files.
    mkdir: CopyFn | None = None


@dataclass(frozen=True, slots=True)
class PrimitiveCopy:
    read_bytes: ReadBytesFn
    write: CopyFn
    mkdir: CopyFn
    readdir: ReaddirFn


CopyStrategy: TypeAlias = NativeCopy | PrimitiveCopy


@dataclass(frozen=True, slots=True)
class NativeMove:
    rename: MoveFn


@dataclass(frozen=True, slots=True)
class PrimitiveMove:
    read_bytes: ReadBytesFn
    write: MoveFn
    mkdir: MoveFn
    readdir: ReaddirFn
    unlink: MoveFn
    rmdir: MoveFn


MoveStrategy: TypeAlias = NativeMove | PrimitiveMove


class MountMode(str, Enum):
    READ = "read"
    WRITE = "write"
    EXEC = "exec"


class MountBackend(StrEnum):
    """How a mount is exposed to the outside world.

    VFS is the default: the mount lives only inside mirage's own filesystem
    and is reached through the command surface, with nothing registered with
    the kernel. FUSE and FSKIT additionally expose it as a real mountpoint.

    NFS serves the tree from a loopback NFSv3 server the kernel mounts,
    which needs no filesystem driver at all: macOS and Linux both ship an
    NFS client. On macOS that also means no admin rights, since a
    loopback NFS mount is unprivileged where macFUSE needs a kext.

    FSKIT is macOS 15.4+ only and needs no kernel extension. It has no
    ``direct_io`` equivalent, so it serves correct reads only for resources
    that set ``SIZES_ALWAYS_KNOWN``; ``mirage.fuse.backend`` warns at mount
    time about resources whose size-unknown files will read as empty. Writes
    are also limited: appends and metadata ops persist, but the macFUSE
    FSKit shim flushes pages a file did not already have (a new file, or
    truncate-then-write) as NUL bytes, a limit pinned in
    ``integ/fuse/truth_fskit.json``.
    There is deliberately no ``auto``: auto-selecting FSKIT would silently
    degrade every API-backed mount.
    """

    VFS = "vfs"
    FUSE = "fuse"
    FSKIT = "fskit"
    NFS = "nfs"


# Backends that register a real mountpoint with the kernel.
KERNEL_BACKENDS: frozenset[MountBackend] = frozenset(
    {MountBackend.FUSE, MountBackend.FSKIT, MountBackend.NFS})

MOUNT_MODE_RANK: dict[MountMode, int] = {
    MountMode.READ: 1,
    MountMode.WRITE: 2,
    MountMode.EXEC: 3,
}


def weaker_mode(a: MountMode, b: MountMode) -> MountMode:
    """The weaker of two mount modes on the READ < WRITE < EXEC lattice.

    Args:
        a (MountMode): first mode.
        b (MountMode): second mode.
    """
    return a if MOUNT_MODE_RANK[a] <= MOUNT_MODE_RANK[b] else b


@dataclass(frozen=True, slots=True)
class HiddenPaths:
    """What the data door treats as nonexistent for one session.

    A sibling of ``Session.mount_modes``: per-session narrowing that
    the doors enforce, None-on-the-session means unrestricted. Hiding
    is "does not exist", never "forbidden" — matching paths answer
    ENOENT and drop out of listings, the same no-name-leak rule
    ``mount_allowed`` applies to ungranted mounts.

    Args:
        paths (tuple[str, ...]): exact virtual paths. Hiding a path
            hides its whole subtree (a name you cannot see cannot be a
            parent you traverse), so a mount root entry hides the
            mount.
        patterns (tuple[str, ...]): globs. A pattern with no ``/``
            matches any single name component anywhere; a pattern
            containing ``/`` is anchored to the full virtual path, with
            ``*`` crossing slashes exactly as GNU ``find -path`` does.
    """

    paths: tuple[str, ...] = ()
    patterns: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ShowEntry:
    """One ``show`` entry of a profile's path axis, compiled.

    Args:
        path (str): the entry as written: an exact subtree or an
            anchored pattern, always absolute. A slashless name pattern
            is refused at validation, because a show anchors to a place
            and a name pattern names none.
        mode (MountMode | None): the mode the entry states for its
            subtree; None for a list-form entry, which inherits the
            mount's.
    """

    path: str
    mode: MountMode | None = None


@dataclass(frozen=True, slots=True)
class ShownPaths:
    """The ``show`` half of one session's path axis.

    A sibling of ``HiddenPaths``: per-session state the doors read,
    None-on-the-session means the document states no show. An entry
    does two things, each on the one anchor-depth rule: it re-opens a
    subtree inside a hidden region when its anchor is deeper than the
    hide's, and it states the mode in force below its anchor when it
    carries one.

    Args:
        entries (tuple[ShowEntry, ...]): the entries, in document
            order.
    """

    entries: tuple[ShowEntry, ...] = ()


@dataclass(frozen=True, slots=True)
class HiddenVars:
    """What the session door treats as unset for one session.

    Enforced where env leaves the session: ``get`` misses, ``snapshot``
    omits, expansion sees unset. Field names differ from
    ``HiddenPaths`` on purpose — the planes' matching semantics differ,
    so the specs are not interchangeable.

    Args:
        names (tuple[str, ...]): exact variable names.
        patterns (tuple[str, ...]): globs over names (``AWS_*``).
    """

    names: tuple[str, ...] = ()
    patterns: tuple[str, ...] = ()


class EntryGate(Protocol):
    """What a command's own I/O asks before touching an entry it
    reached below its operands.

    The admission gate judges the paths a line names; a walk (``grep
    -r``, ``find``, ``du``, ``cp -r``, ``tar``) then reaches entries no
    rule has seen. The dispatcher binds the admitted command's gate to
    the session context for the command's run, and the commands tier
    reads it there, so the tier that enforces the rules never imports
    the tier that states them.

    Args:
        scoped (bool): whether a path rule in force reads this command's
            paths at all; a native walk (a backend's own find or du)
            yields to the guarded readdir walk while it is set, so each
            entry passes the gate.
        granted (tuple[CommandRule, ...]): the ask rules this line runs
            under a grant for. Read by the op doors, which see the same
            entries from below and would otherwise re-derive a verdict
            that knows nothing of the nod the gate already took.
    """

    @property
    def scoped(self) -> bool:
        ...

    @property
    def granted(self) -> "tuple[CommandRule, ...]":
        ...

    def check(self, virtual: str) -> None:
        """Raise when a rule in force refuses this entry for the running
        command; return when the command may touch it.

        Args:
            virtual (str): absolute virtual path of the entry.
        """
        ...


MOUNT_MODE_ALIASES: dict[str, MountMode] = {
    "r": MountMode.READ,
    "rw": MountMode.WRITE,
    "rwx": MountMode.EXEC,
}


def parse_mount_mode(value: MountMode | str) -> MountMode:
    """Coerce a mount mode, accepting cumulative filesystem aliases.

    The mode ladder is cumulative (exec implies write implies read),
    so only the cumulative spellings ``r``, ``rw``, ``rwx`` alias the
    modes; bit-style forms like ``w`` or ``x`` are rejected.

    Args:
        value (MountMode | str): a mode name ("read", "write", "exec")
            or its filesystem alias ("r", "rw", "rwx").
    """
    if isinstance(value, MountMode):
        return value
    alias = MOUNT_MODE_ALIASES.get(value)
    return alias if alias is not None else MountMode(value)


class ConsistencyPolicy(str, Enum):
    LAZY = "lazy"
    ALWAYS = "always"


class OnExceed(str, Enum):
    ERROR = "error"
    TRUNCATE = "truncate"


def _prefer_error(values: Iterable["OnExceed"]) -> "OnExceed":
    return (OnExceed.ERROR if any(v is OnExceed.ERROR
                                  for v in values) else OnExceed.TRUNCATE)


class Limit(BaseModel):
    """A bound on a result: the policy layer's limit arm and the shape
    every cap config parses into.

    Carries its fields inline (the Deny precedent: an action is its
    payload). ``kind`` is the wire discriminant; ``aggr`` is the
    composition law (AND to the tightest per bound, ANY on error mode).
    """

    kind: ClassVar[str] = "limit"

    max_bytes: Annotated[NonNegativeInt | None, Aggr(_min_positive)] = None
    max_lines: Annotated[NonNegativeInt | None, Aggr(_min_positive)] = None
    timeout_seconds: Annotated[float | None, Aggr(_min_positive)] = None
    on_exceed: Annotated[OnExceed, Aggr(_prefer_error)] = OnExceed.TRUNCATE

    @classmethod
    def aggr(
        cls,
        limits: "Iterable[Limit | None]",
    ) -> "Limit | None":
        """Aggregate several limits using each field's declared rule.

        Every field carries an Aggr(rule) in its annotation; this applies
        that rule to the field's values across the present limits. Returns
        None when nothing is configured. Used wherever bounds stack
        (policy composition, cross-mount fan-out, layered configs).

        Args:
            limits (Iterable[Limit | None]): limits to merge.
        """
        present = [s for s in limits if s is not None]
        if not present:
            return None
        kwargs: dict[str, Any] = {}
        for name, field in cls.model_fields.items():
            rule = next((m for m in field.metadata if isinstance(m, Aggr)),
                        None)
            values = [getattr(s, name) for s in present]
            kwargs[name] = rule.reduce(
                values) if rule is not None else values[0]
        return cls(**kwargs)


@dataclass(frozen=True, slots=True)
class Producer:
    """Provenance of a result: who produced it, and where.

    Rides the IO envelope from the dispatch site to the workspace
    boundary; merge keeps the rightmost producer, so this names the
    command whose stream the caller actually sees. Post-layer policies
    (output caps today; budgets and attribution later) read it as
    context. Facts only: policy decisions never travel on the
    envelope.

    Args:
        command (str): the producing command's name.
        prefixes (tuple[str, ...]): mount prefixes the command spanned.
        declared (Limit | None): the bound the command's own
            registration declared, when the dispatch site knows it
            (e.g. a CLI leaf); None for commands with no declaration.
    """

    command: str
    prefixes: tuple[str, ...] = ()
    declared: Limit | None = None


class VFSWriteOp(str, Enum):
    WRITE = "write"
    UNLINK = "unlink"
    RMDIR = "rmdir"
    MKDIR = "mkdir"
    RENAME = "rename"
    TRUNCATE = "truncate"
    CREATE = "create"
    APPEND = "append"


WRITE_OPS = frozenset(VFSWriteOp)


class ResourceName(str, Enum):
    DISK = "disk"
    S3 = "s3"
    RAM = "ram"
    GITHUB = "github"
    LINEAR = "linear"
    GCAL = "gcal"
    GDOCS = "gdocs"
    GSHEETS = "gsheets"
    GSLIDES = "gslides"
    GDRIVE = "gdrive"
    SLACK = "slack"
    DISCORD = "discord"
    GMAIL = "gmail"
    TRELLO = "trello"
    MONGODB = "mongodb"
    GRIDFS = "gridfs"
    POSTGRES = "postgres"
    NOTION = "notion"
    LANGFUSE = "langfuse"
    JAEGER = "jaeger"
    SSH = "ssh"
    REDIS = "redis"
    GCS = "gcs"
    EMAIL = "email"
    DIFY = "dify"
    MEM0 = "mem0"
    CHROMA = "chroma"
    DATABRICKS_VOLUME = "databricks_volume"
    HF_BUCKETS = "hf_buckets"
    HF_DATASETS = "hf_datasets"
    HF_MODELS = "hf_models"
    HF_SPACES = "hf_spaces"
    NEXTCLOUD = "nextcloud"
    LANCEDB = "lancedb"
    ONEDRIVE = "onedrive"
    DROPBOX = "dropbox"
    QDRANT = "qdrant"
    SHAREPOINT = "sharepoint"
    BOX = "box"


@dataclass(frozen=True, init=False)
class PathSpec:
    virtual: str
    directory: str
    resource_path: str
    raw_path: str
    pattern: str | None = None
    resolved: bool = True

    def __init__(
        self,
        virtual: str,
        directory: str,
        resource_path: str,
        pattern: str | None = None,
        resolved: bool = True,
        raw_path: str | None = None,
    ) -> None:
        """Create a path whose stored spelling is always concrete.

        Args:
            virtual (str): Absolute path in the workspace.
            directory (str): Directory containing the path.
            resource_path (str): Path relative to the mounted resource.
            pattern (str | None): Unresolved glob pattern.
            resolved (bool): Whether glob resolution is complete.
            raw_path (str | None): Spelling supplied by the user; defaults
                to ``virtual`` only at the construction boundary.
        """
        object.__setattr__(self, "virtual", virtual)
        object.__setattr__(self, "directory", directory)
        object.__setattr__(self, "resource_path", resource_path)
        object.__setattr__(self, "pattern", pattern)
        object.__setattr__(self, "resolved", resolved)
        object.__setattr__(self, "raw_path",
                           virtual if raw_path is None else raw_path)

    @property
    def mount_path(self) -> str:
        """Mount-relative path with a leading slash.

        Pure formatting of ``resource_path`` ("" -> "/", "sub/x" ->
        "/sub/x"); used for byte-accounting keys and path arithmetic that
        work in slash-framed mount-relative space.
        """
        return "/" + self.resource_path

    @property
    def dir(self) -> "PathSpec":
        """Directory PathSpec, carrying pattern for readdir filtering."""
        # The directory's resource_path is its virtual form with this
        # path's mount prefix removed; the prefix length is recovered from
        # the (virtual, resource_path) pair. Idempotent for specs that are
        # already directories.
        cut = len(self.virtual.rstrip("/")) - len(self.resource_path)
        return PathSpec(
            virtual=self.directory,
            directory=self.directory,
            pattern=self.pattern,
            resolved=False,
            resource_path=self.directory[cut:].strip("/"),
        )

    def child(self, name: str) -> str:
        return self.virtual.rstrip("/") + "/" + name

    @staticmethod
    def from_str_path(path: str,
                      resource_path: str | None = None) -> "PathSpec":
        """Wrap a path string; defaults to a root-mounted resource_path.

        Args:
            path (str): virtual path string.
            resource_path (str | None): backend key; when None the path is
                assumed root-mounted (no mount prefix to strip).
        """
        return PathSpec(
            virtual=path,
            directory=path[:path.rfind("/") + 1] or "/",
            resource_path=(path.strip("/")
                           if resource_path is None else resource_path),
        )


def word_text(word: "str | PathSpec") -> str:
    """Shell-text form of an argv word.

    Text words pass through; paths render as spelled (``raw_path``).
    Use wherever a word re-enters string space (env values, function
    args, the argv text view). Mount I/O keeps using ``virtual``.

    Args:
        word (str | PathSpec): text argument or path.
    """
    if isinstance(word, PathSpec):
        return word.raw_path
    return word


class FileChangeKind(StrEnum):
    """Kind of an externally observed file change.

    Shared vocabulary of the watch feature; the producer
    (``Workspace.watch``) and the watch machinery both depend on it, so
    it lives here as a leaf type next to ``PathSpec`` / ``FileStat``.

    Values:
        CREATE: path appeared since the previous checkpoint.
        UPDATE: path content or metadata changed.
        DELETE: path disappeared.
        MOVE: path was renamed; reserved for sources that can express
            it, poll-diff sources emit DELETE + CREATE instead.
        UNKNOWN: precision was lost (queue overflow, checkpoint reset);
            everything under the path must be re-inventoried.
    """
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    MOVE = "move"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class FileMetadata:
    """Post-change metadata a change source can attach to an event.

    Every field is optional: producers fill only what their signal
    honestly carries (a listing walk knows fingerprint/size/modified; a
    webhook payload usually knows none). Growth point for future
    backend facts (owner, inode) as sources that can supply them
    appear.

    Args:
        fingerprint (str | None): Content fingerprint after the change
            (same concept as ``FileStat.fingerprint``: ETag/rev, or the
            mtime|size composite), so consumers can skip no-op
            reprocessing.
        size (int | None): Content size in bytes after the change.
        modified (str | None): Last-modified stamp after the change.
    """
    fingerprint: str | None = None
    size: int | None = None
    modified: str | None = None


@dataclass(frozen=True, slots=True)
class FileEvent:
    """One externally observed change to a mounted file path.

    Level-triggered: an event tells the consumer *what is dirty*, not
    every intermediate edit. Consumers read current content through the
    workspace after receiving an event; the watch runtime guarantees
    caches were invalidated before delivery, so that read is fresh.

    Args:
        kind (FileChangeKind): What happened to the path.
        path (PathSpec): Virtual path of the changed entry.
        timestamp (datetime): UTC time the change was observed (not
            when it happened; webhook lag and poll cadence sit in
            between).
        previous_path (PathSpec | None): Prior path for MOVE events.
        metadata (FileMetadata | None): Post-change metadata when the
            source carries it; None otherwise.
    """
    kind: FileChangeKind
    path: PathSpec
    timestamp: datetime
    previous_path: PathSpec | None = None
    metadata: FileMetadata | None = None


@dataclass(frozen=True, slots=True)
class Delta:
    """Result of one checkpointed delta pull.

    Args:
        changes (tuple[FileEvent, ...]): Changes since the given
            checkpoint; empty on a baseline pull.
        checkpoint (str | None): Opaque serialized state to pass to the
            next pull.
    """
    changes: tuple[FileEvent, ...]
    checkpoint: str | None


@dataclass(frozen=True, slots=True)
class WalkEntry:
    """One entry produced by a backend walk feeding change detection.

    Args:
        virtual (str): Workspace-virtual path of the entry.
        is_dir (bool): Whether the entry is a directory.
        fingerprint (str | None): Content fingerprint (see
            ``mirage.watch.fingerprint.stat_fingerprint``). None means
            only create/delete are detectable for this entry.
        size (int | None): Content size in bytes, when the listing
            carries it.
        modified (str | None): Last-modified stamp, when the listing
            carries it.
    """
    virtual: str
    is_dir: bool
    fingerprint: str | None
    size: int | None = None
    modified: str | None = None


WalkFn: TypeAlias = Callable[[PathSpec], AsyncIterator[WalkEntry]]


class OverflowPolicy(StrEnum):
    """Behaviour of a watch queue when pending changes exceed its cap.

    Values:
        COLLAPSE: drop all pending entries and replace them with one
            UNKNOWN change at the watch root (default; level-triggered
            "rescan" semantics).
        DROP_OLDEST: evict the oldest pending entry.
        ERROR: surface QueueOverflowError to the consumer iterator.
    """
    COLLAPSE = "collapse"
    DROP_OLDEST = "drop_oldest"
    ERROR = "error"


class DriftPolicy(StrEnum):
    """Behaviour when a remote resource's live fingerprint differs from
    the value recorded at snapshot time.

    Values:
        STRICT: raise ContentDriftError on mismatch (default).
        OFF: skip drift checks entirely.
    """
    STRICT = "strict"
    OFF = "off"
