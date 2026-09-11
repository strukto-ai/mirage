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
    DEFAULT_AGENT_ID = "default_agent_id"
    CURRENT_AGENT_ID = "current_agent_id"
    CACHE = "cache"
    HISTORY = "history"
    JOBS = "jobs"
    FINGERPRINTS = "fingerprints"
    LIVE_ONLY_MOUNTS = "live_only_mounts"
    NODES = "nodes"
    CLIS = "clis"


class MountKey(StrEnum):
    INDEX = "index"
    PREFIX = "prefix"
    MODE = "mode"
    CONSISTENCY = "consistency"
    RESOURCE_CLASS = "resource_class"
    RESOURCE_REF = "resource_ref"
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


class ResourceStateKey(StrEnum):
    TYPE = "type"
    CONFIG = "config"
    NEEDS_OVERRIDE = "needs_override"
    FILES = "files"
    DIRS = "dirs"
    MODIFIED = "modified"
    KEY_PREFIX = "key_prefix"


# The four below name sub-shapes that typescript spells as literals at
# the point of use rather than as a frozen table (`keys.ts` stops at
# ResourceStateKey). They belong to the same snapshot vocabulary, so
# they live here too instead of staying behind in `types.py`.
# NodeMetaKey is the exception: it names NodeMeta's own fields, so it
# lives beside NodeMeta in `mount/namespace/namespace.py`. Snapshot
# serializes the namespace, not the other way round, and importing
# this package from there closes an import cycle.
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
    RUNTIME = "runtime"


class ScriptKey(StrEnum):
    SOURCE = "source"
    LANGUAGE = "language"
    MODULE = "module"


class SessionKey(StrEnum):
    SESSION_ID = "session_id"
    CWD = "cwd"
    ENV = "env"
    LAST_EXIT_CODE = "last_exit_code"
