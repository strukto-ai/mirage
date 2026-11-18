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

from enum import StrEnum


class StateKey(StrEnum):
    VERSION = "version"
    MIRAGE_VERSION = "mirage_version"
    MOUNTS = "mounts"
    SESSIONS = "sessions"
    ENV = "env"
    DEFAULT_SESSION_ID = "default_session_id"
    IO = "io"
    CACHE = "cache"
    HISTORY = "history"
    JOBS = "jobs"
    LINES = "lines"
    PROCESS_RECORDS = "process_records"
    FINGERPRINTS = "fingerprints"
    LIVE_ONLY_MOUNTS = "live_only_mounts"
    NODES = "nodes"
    CLIS = "clis"
    WRITE = "write"
    PROFILES = "profiles"
    PROFILE = "profile"
    PROCESSES = "processes"
    COMMAND_LIMITS = "command_limits"
    MAX_MEMORY = "max_memory"
    MAX_ENV = "max_env"
    MAX_BODY_BYTES = "max_body_bytes"
    NETWORK = "network"
    SYSTEM_TIME = "system_time"


class MountKey(StrEnum):
    INDEX = "index"
    PREFIX = "prefix"
    MODE = "mode"
    READ = "read"
    TTL = "ttl"
    WRITE = "write"
    VFS_CLASS = "vfs_class"
    VFS_REF = "vfs_ref"
    INDEX_CONFIG = "index_config"
    VFS_STATE = "vfs_state"
    ANCHOR = "anchor"
    COMMAND_LIMITS = "command_limits"


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
    PROCESS = "process"
    ID = "id"
    COMMAND = "command"
    CWD = "cwd"
    SIGNAL = "signal"
    STDOUT = "stdout"
    STDERR = "stderr"
    EXIT_CODE = "exit_code"
    CREATED_AT = "created_at"
    ENDED_AT = "ended_at"
    SESSION_ID = "session_id"
    LINE = "line"
    GROUP = "group"


class VFSStateKey(StrEnum):
    TYPE = "type"
    CONFIG = "config"
    NEEDS_OVERRIDE = "needs_override"
    FILES = "files"
    DIRS = "dirs"
    MODIFIED = "modified"


class FingerprintKey(StrEnum):
    PATH = "path"
    MOUNT_PREFIX = "mount_prefix"
    FINGERPRINT = "fingerprint"
    REVISION = "revision"


class CLIKey(StrEnum):
    NAME = "name"
    SPEC = "spec"
    CONFIG = "config"
    SCRIPT = "script"
    MACHINE = "machine"
    RUNTIME = "runtime"
    MCP = "mcp"


class MCPKey(StrEnum):
    TITLE = "title"
    TOOLS = "tools"
    NAME = "name"
    DESCRIPTION = "description"
    INPUT_SCHEMA = "input_schema"
    ANNOTATIONS = "annotations"


class ScriptKey(StrEnum):
    SOURCE = "source"
    LANGUAGE = "language"
    MODULE = "module"
