// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

export const StateKey = Object.freeze({
  VERSION: 'version',
  MIRAGE_VERSION: 'mirage_version',
  MOUNTS: 'mounts',
  SESSIONS: 'sessions',
  DEFAULT_SESSION_ID: 'default_session_id',
  DEFAULT_AGENT_ID: 'default_agent_id',
  CURRENT_AGENT_ID: 'current_agent_id',
  CACHE: 'cache',
  HISTORY: 'history',
  JOBS: 'jobs',
  FINGERPRINTS: 'fingerprints',
  LIVE_ONLY_MOUNTS: 'live_only_mounts',
  NODES: 'nodes',
} as const)

export const MountKey = Object.freeze({
  INDEX: 'index',
  PREFIX: 'prefix',
  MODE: 'mode',
  CONSISTENCY: 'consistency',
  RESOURCE_CLASS: 'resource_class',
  RESOURCE_STATE: 'resource_state',
} as const)

export const CacheKey = Object.freeze({
  LIMIT: 'limit',
  MAX_DRAIN_BYTES: 'max_drain_bytes',
  ENTRIES: 'entries',
  KEY: 'key',
  DATA: 'data',
  FINGERPRINT: 'fingerprint',
  TTL: 'ttl',
  CACHED_AT: 'cached_at',
  SIZE: 'size',
} as const)

export const JobKey = Object.freeze({
  ID: 'id',
  COMMAND: 'command',
  CWD: 'cwd',
  STATUS: 'status',
  STDOUT: 'stdout',
  STDERR: 'stderr',
  EXIT_CODE: 'exit_code',
  CREATED_AT: 'created_at',
  AGENT: 'agent',
  SESSION_ID: 'session_id',
} as const)

export const ResourceStateKey = Object.freeze({
  TYPE: 'type',
  CONFIG: 'config',
  FILES: 'files',
  DIRS: 'dirs',
  MODIFIED: 'modified',
  KEY_PREFIX: 'key_prefix',
} as const)
