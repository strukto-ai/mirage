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

export const ENV_SSH_PORT = 'MIRAGE_SSH_PORT'
export const ENV_SSH_HOST = 'MIRAGE_SSH_HOST'
export const ENV_SSH_HOST_KEY_FILE = 'MIRAGE_SSH_HOST_KEY_FILE'
export const ENV_SSH_AUTHORIZED_KEYS = 'MIRAGE_SSH_AUTHORIZED_KEYS'

export const DEFAULT_SSH_HOST = '127.0.0.1'
export const SSH_DIR = 'ssh'
export const HOST_KEY_NAME = 'host_ed25519_key'
export const AUTHORIZED_KEYS_NAME = 'authorized_keys'

/**
 * The authorized_keys option that binds a key to one of the workspace's
 * profiles (`mirage-profile="guarded" ssh-ed25519 AAAA...`). The server
 * reads it, never the client, so a key cannot pick a looser profile.
 */
export const PROFILE_OPTION = 'mirage-profile'

// The authorized_keys option naming the account a key belongs to
// (`mirage-account="alice" ssh-ed25519 AAAA...`). The account opens only
// the workspaces it owns; in jwt mode a key without one opens nothing.
export const ACCOUNT_OPTION = 'mirage-account'

// A client that answers no keepalive for this many intervals is gone, so
// its connection closes and the line it was running is cancelled rather
// than left behind a half-open socket.
export const KEEPALIVE_INTERVAL_SECONDS = 15
export const KEEPALIVE_COUNT_MAX = 3

/**
 * The subsystem Codex opens (`ssh ... -s codex-exec`) to run its tools in
 * a workspace. It speaks Codex's exec-server protocol: one JSON-RPC
 * message per line, without the `jsonrpc` member.
 */
export const CODEX_SUBSYSTEM = 'codex-exec'
export const CODEX_AGENT_ID = 'codex'
export const CODEX_SHELL_NAME = 'bash'
export const CODEX_SHELL_PATH = '/bin/bash'
export const CODEX_SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash'])
/**
 * One message carries a whole file as base64 (`fs/writeFile`), so a
 * message may run far past a shell line.
 */
export const CODEX_MAX_MESSAGE = 64 * 1024 * 1024
export const CODEX_READ_SIZE = 1024 * 1024
/**
 * The output a process keeps for `process/read`, oldest dropped first.
 * Codex takes output from notifications, so this is a bounded replay.
 */
export const CODEX_RETAINED_OUTPUT = 1024 * 1024
export const CODEX_INTERRUPT_SIGNAL = 'interrupt'
export const CODEX_CTRL_C = 0x03
export const CODEX_CTRL_D = 0x04
/**
 * Exit statuses the protocol reports for a stopped process: an interrupt
 * reads as 128 + SIGINT, a terminated process as no status.
 */
export const CODEX_INTERRUPTED = 130
export const CODEX_TERMINATED = -1

export const SSH_ENV_KEYS = {
  ssh_port: ENV_SSH_PORT,
  ssh_host: ENV_SSH_HOST,
  ssh_host_key_file: ENV_SSH_HOST_KEY_FILE,
  ssh_authorized_keys: ENV_SSH_AUTHORIZED_KEYS,
} as const
