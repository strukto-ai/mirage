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

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from enum import Enum, StrEnum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, NonNegativeInt


class Aggr:
    """Declares how one CommandSafeguard field aggregates across guards.

    Attach to a field via Annotated[..., Aggr(rule)]; ``rule`` takes the
    list of that field's values across the stacked safeguards and returns
    the aggregated value. CommandSafeguard.aggr reads these rules so each
    field's aggregation behavior lives next to the field.

    Args:
        reduce (Callable[[list], object]): the per-field aggregation rule.
    """

    def __init__(self, reduce: Callable[[list], object]) -> None:
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
    DIRECTORY = "directory"
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
    PARQUET = "parquet"
    ORC = "orc"
    FEATHER = "feather"
    HDF5 = "hdf5"


class FileStat(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    size: int | None = None
    modified: str | None = None
    fingerprint: str | None = None
    revision: str | None = None
    type: FileType | None = None
    mode: int | None = None
    uid: int | str | None = None
    gid: int | str | None = None
    atime: str | None = None
    extra: dict = Field(default_factory=dict)


class MountMode(str, Enum):
    READ = "read"
    WRITE = "write"
    EXEC = "exec"


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


class CommandSafeguard(BaseModel):
    max_bytes: Annotated[NonNegativeInt | None, Aggr(_min_positive)] = None
    max_lines: Annotated[NonNegativeInt | None, Aggr(_min_positive)] = None
    timeout_seconds: Annotated[float | None, Aggr(_min_positive)] = None
    on_exceed: Annotated[OnExceed, Aggr(_prefer_error)] = OnExceed.TRUNCATE

    @classmethod
    def aggr(
        cls,
        safeguards: "Iterable[CommandSafeguard | None]",
    ) -> "CommandSafeguard | None":
        """Aggregate several safeguards using each field's declared rule.

        Every field carries an Aggr(rule) in its annotation; this applies
        that rule to the field's values across the present guards. Returns
        None when nothing is configured. Used wherever guards stack
        (cross-mount fan-out, layered configs).

        Args:
            safeguards (Iterable[CommandSafeguard | None]): guards to merge.
        """
        present = [s for s in safeguards if s is not None]
        if not present:
            return None
        kwargs = {}
        for name, field in cls.model_fields.items():
            rule = next((m for m in field.metadata if isinstance(m, Aggr)),
                        None)
            values = [getattr(s, name) for s in present]
            kwargs[name] = rule.reduce(
                values) if rule is not None else values[0]
        return cls(**kwargs)


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
    GDOCS = "gdocs"
    GSHEETS = "gsheets"
    GSLIDES = "gslides"
    GDRIVE = "gdrive"
    SLACK = "slack"
    DISCORD = "discord"
    GMAIL = "gmail"
    TRELLO = "trello"
    MONGODB = "mongodb"
    POSTGRES = "postgres"
    NOTION = "notion"
    LANGFUSE = "langfuse"
    SSH = "ssh"
    REDIS = "redis"
    GITHUB_CI = "github_ci"
    GCS = "gcs"
    EMAIL = "email"
    DIFY = "dify"
    CHROMA = "chroma"
    DATABRICKS_VOLUME = "databricks_volume"
    HF_BUCKETS = "hf_buckets"
    HF_DATASETS = "hf_datasets"
    HF_MODELS = "hf_models"
    HF_SPACES = "hf_spaces"
    NEXTCLOUD = "nextcloud"
    LANCEDB = "lancedb"
    ONEDRIVE = "onedrive"
    QDRANT = "qdrant"
    SHAREPOINT = "sharepoint"


@dataclass(frozen=True)
class PathSpec:
    virtual: str
    directory: str
    resource_path: str
    pattern: str | None = None
    resolved: bool = True
    raw_path: str | None = None

    def __post_init__(self) -> None:
        """Default ``raw_path`` to ``virtual``.

        ``raw_path`` is the word's spelling: as typed for relative
        words, the absolute path for everything else. It is always a
        ``str`` after construction; pass None to take the default.
        """
        if self.raw_path is None:
            object.__setattr__(self, "raw_path", self.virtual)

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
    return word.raw_path if isinstance(word, PathSpec) else word


class IndexType(str, Enum):
    RAM = "ram"
    REDIS = "redis"


class CacheType(str, Enum):
    RAM = "ram"
    REDIS = "redis"


class RuntimeType(str, Enum):
    RAM = "ram"
    DISK = "disk"


DEFAULT_SESSION_ID = "default"
DEFAULT_AGENT_ID = "default"


class StateKey(StrEnum):
    VERSION = "version"
    MIRAGE_VERSION = "mirage_version"
    MOUNTS = "mounts"
    SESSIONS = "sessions"
    DEFAULT_SESSION_ID = "default_session_id"
    DEFAULT_AGENT_ID = "default_agent_id"
    CURRENT_AGENT_ID = "current_agent_id"
    CACHE = "cache"
    HISTORY = "history"
    JOBS = "jobs"
    FINGERPRINTS = "fingerprints"
    LIVE_ONLY_MOUNTS = "live_only_mounts"
    NODES = "nodes"


class DriftPolicy(StrEnum):
    """Behaviour when a remote resource's live fingerprint differs from
    the value recorded at snapshot time.

    Values:
        STRICT: raise ContentDriftError on mismatch (default).
        OFF: skip drift checks entirely.
    """
    STRICT = "strict"
    OFF = "off"


class FingerprintKey(StrEnum):
    PATH = "path"
    MOUNT_PREFIX = "mount_prefix"
    FINGERPRINT = "fingerprint"
    REVISION = "revision"


class MountKey(StrEnum):
    INDEX = "index"
    PREFIX = "prefix"
    MODE = "mode"
    CONSISTENCY = "consistency"
    RESOURCE_CLASS = "resource_class"
    RESOURCE_STATE = "resource_state"


class CacheKey(StrEnum):
    LIMIT = "limit"
    MAX_DRAIN_BYTES = "max_drain_bytes"
    ENTRIES = "entries"
    KEY = "key"
    DATA = "data"
    FINGERPRINT = "fingerprint"
    TTL = "ttl"
    CACHED_AT = "cached_at"
    SIZE = "size"


class JobKey(StrEnum):
    ID = "id"
    COMMAND = "command"
    CWD = "cwd"
    STATUS = "status"
    STDOUT = "stdout"
    STDERR = "stderr"
    EXIT_CODE = "exit_code"
    CREATED_AT = "created_at"
    AGENT = "agent"
    SESSION_ID = "session_id"


class RecordKey(StrEnum):
    AGENT = "agent"
    COMMAND = "command"
    STDOUT = "stdout"
    STDIN = "stdin"
    EXIT_CODE = "exit_code"
    TREE = "tree"
    TIMESTAMP = "timestamp"
    SESSION_ID = "session_id"


class NodeKey(StrEnum):
    COMMAND = "command"
    OP = "op"
    STDERR = "stderr"
    EXIT_CODE = "exit_code"
    CHILDREN = "children"


class SessionKey(StrEnum):
    SESSION_ID = "session_id"
    CWD = "cwd"
    ENV = "env"
    LAST_EXIT_CODE = "last_exit_code"


class ResourceStateKey(StrEnum):
    TYPE = "type"
    CONFIG = "config"
    FILES = "files"
    DIRS = "dirs"
    MODIFIED = "modified"
    KEY_PREFIX = "key_prefix"
