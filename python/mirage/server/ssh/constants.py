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

ENV_SSH_PORT = "MIRAGE_SSH_PORT"
ENV_SSH_HOST = "MIRAGE_SSH_HOST"
ENV_SSH_HOST_KEY_FILE = "MIRAGE_SSH_HOST_KEY_FILE"
ENV_SSH_AUTHORIZED_KEYS = "MIRAGE_SSH_AUTHORIZED_KEYS"

DEFAULT_SSH_HOST = "127.0.0.1"
SSH_DIR = "ssh"
HOST_KEY_NAME = "host_ed25519_key"
AUTHORIZED_KEYS_NAME = "authorized_keys"

# The module that serves the entry point. It imports asyncssh, which is the
# `ssh` extra, so the daemon loads it by path only once a port is set or
# the HTTPS route carries a connection.
SERVER_MODULE = "mirage.server.ssh.server:start_ssh_server"
TUNNEL_MODULE = "mirage.server.ssh.server:serve_tunnel"

# How many bytes the HTTPS route relays at a time.
TUNNEL_CHUNK = 64 * 1024

# How much of each stream's start and end the entry point keeps to tell whether
# a refusal already says why: the refused command's own diagnostic sits
# near the start of a line refused early and near the end of one refused
# late, so both ends hold it without the whole output.
REFUSAL_WINDOW = 4096

# The most entry stats one listing keeps in flight. Each is a hop to the
# workspace loop and, on a mount that keeps no listing index, a backend
# request, so a wide directory does not put every one on the wire.
LISTING_CONCURRENCY = 16

# The authorized_keys option that binds a key to one of the workspace's
# profiles (`mirage-profile="guarded" ssh-ed25519 AAAA...`). The server
# reads it, never the client, so a key cannot pick a looser profile.
PROFILE_OPTION = "mirage-profile"

# The authorized_keys option naming the account a key belongs to
# (`mirage-account="alice" ssh-ed25519 AAAA...`). The account opens only
# the workspaces it owns; in jwt mode a key without one opens nothing.
ACCOUNT_OPTION = "mirage-account"

# A client that answers no keepalive for this many intervals is gone,
# so its connection closes and the line it was running is cancelled
# rather than left behind a half-open socket.
KEEPALIVE_INTERVAL_SECONDS = 15
KEEPALIVE_COUNT_MAX = 3

# The subsystem Codex opens (`ssh ... -s codex-exec`) to run its tools in
# a workspace. It speaks Codex's exec-server protocol: one JSON-RPC
# message per line, without the `jsonrpc` member.
CODEX_SUBSYSTEM = "codex-exec"
CODEX_AGENT_ID = "codex"
CODEX_SHELL_NAME = "bash"
CODEX_SHELL_PATH = "/bin/bash"
CODEX_SHELLS = frozenset({"bash", "sh", "zsh", "dash"})
# One message carries a whole file as base64 (`fs/writeFile`), so a
# message may run far past a shell line.
CODEX_MAX_MESSAGE = 64 * 1024 * 1024
CODEX_READ_SIZE = 1024 * 1024
# The output a process keeps for `process/read`, oldest dropped first.
# Codex takes output from notifications, so this is a bounded replay.
CODEX_RETAINED_OUTPUT = 1024 * 1024
CODEX_INTERRUPT_SIGNAL = "interrupt"
CODEX_CTRL_C = b"\x03"
CODEX_CTRL_D = b"\x04"
# Exit statuses the protocol reports for a stopped process: an
# interrupt reads as 128 + SIGINT, a terminated process as no status.
CODEX_INTERRUPTED = 130
CODEX_TERMINATED = -1

SSH_ENV_KEYS = {
    "ssh_port": ENV_SSH_PORT,
    "ssh_host": ENV_SSH_HOST,
    "ssh_host_key_file": ENV_SSH_HOST_KEY_FILE,
    "ssh_authorized_keys": ENV_SSH_AUTHORIZED_KEYS,
}
