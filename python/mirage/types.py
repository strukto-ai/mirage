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

from dataclasses import dataclass
from enum import Enum, StrEnum
from typing import NewType

from pydantic import BaseModel, ConfigDict, Field

Fingerprint = NewType("Fingerprint", str)
Revision = NewType("Revision", str)


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
    fingerprint: Fingerprint | None = None
    revision: Revision | None = None
    type: FileType | None = None
    extra: dict = Field(default_factory=dict)


class MountMode(str, Enum):
    READ = "read"
    WRITE = "write"
    EXEC = "exec"


class ConsistencyPolicy(str, Enum):
    LAZY = "lazy"
    ALWAYS = "always"


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
    TELEGRAM = "telegram"
    MONGODB = "mongodb"
    POSTGRES = "postgres"
    NOTION = "notion"
    LANGFUSE = "langfuse"
    SSH = "ssh"
    REDIS = "redis"
    GITHUB_CI = "github_ci"
    GCS = "gcs"
    EMAIL = "email"
    PAPERCLIP = "paperclip"


@dataclass(frozen=True)
class PathSpec:
    original: str
    directory: str
    pattern: str | None = None
    resolved: bool = True
    prefix: str = ""

    @property
    def strip_prefix(self) -> str:
        if self.prefix and self.original.startswith(self.prefix):
            return self.original[len(self.prefix):] or "/"
        return self.original

    @property
    def key(self) -> str:
        return self.strip_prefix.strip("/")

    @property
    def dir(self) -> "PathSpec":
        """Directory PathSpec, carrying pattern for readdir filtering."""
        return PathSpec(
            original=self.directory,
            directory=self.directory,
            pattern=self.pattern,
            resolved=False,
            prefix=self.prefix,
        )

    def child(self, name: str) -> str:
        return self.original.rstrip("/") + "/" + name

    @staticmethod
    def from_str_path(path: str, prefix: str = "") -> "PathSpec":
        return PathSpec(
            original=path,
            directory=path[:path.rfind("/") + 1] or "/",
            prefix=prefix,
        )


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
    NEEDS_OVERRIDE = "needs_override"
    REDACTED_FIELDS = "redacted_fields"
    CONFIG = "config"
    FILES = "files"
    DIRS = "dirs"
    MODIFIED = "modified"
    KEY_PREFIX = "key_prefix"
