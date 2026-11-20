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

# The modules that serve the entry points. They import asyncssh, which is
# the `ssh` extra, so the daemon loads them by path only once a port is set
# or an HTTPS route carries a connection.
SERVER_MODULE = "mirage.server.ssh.server:start_ssh_server"
TUNNEL_MODULE = "mirage.server.ssh.server:serve_tunnel"
CODEX_SOCKET_MODULE = "mirage.server.ssh.codex:serve_codex_socket"

# How many bytes the HTTPS route relays at a time.
TUNNEL_CHUNK = 64 * 1024

# The hosts a forward may name: the loopback of the machine its login's
# lines run on, the one place a forward reaches.
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost"})

# What a forward to any other host is refused with.
FORWARD_REFUSED = "only 127.0.0.1 and localhost are forwarded"

# The relay FORWARD_LINE runs where the machine has python3: its stdin to
# the port and the port to its stdout, ending its writes at end of input.
FORWARD_RELAY_PY = (
    "import os,socket,sys,threading\n"
    's=socket.create_connection(("127.0.0.1",int(sys.argv[1])))\n'
    "def up():\n"
    " while b:=os.read(0,65536):s.sendall(b)\n"
    " s.shutdown(socket.SHUT_WR)\n"
    "threading.Thread(target=up,daemon=True).start()\n"
    "o=sys.stdout.buffer\n"
    "while b:=s.recv(65536):o.write(b);o.flush()\n"
)

# The line a forward runs, as its login's lines run, to reach {port} on
# that machine's loopback: the first relay the machine has, socat,
# python3 or bash, joins the forward's channel to it.
FORWARD_LINE = (
    "if command -v socat >/dev/null 2>&1; "
    "then exec socat - TCP:127.0.0.1:{port}; fi; "
    "if command -v python3 >/dev/null 2>&1; "
    f"then exec python3 -c '{FORWARD_RELAY_PY}' {{port}}; fi; "
    "if command -v bash >/dev/null 2>&1; "
    "then exec bash -c 'exec 3<>/dev/tcp/127.0.0.1/$1 || exit 1; "
    "cat <&3 & cat >&3; wait' forward {port}; fi; "
    'echo "forward: no socat, python3 or bash" >&2; exit 127'
)

# The authorized_keys option that binds a key to one of the workspace's
# profiles (`mirage-profile="guarded" ssh-ed25519 AAAA...`). The server
# reads it, never the client, so a key cannot pick a looser profile.
PROFILE_OPTION = "mirage-profile"

# The authorized_keys option naming the account a key belongs to
# (`mirage-account="alice" ssh-ed25519 AAAA...`). The account opens only
# the workspaces it owns; in jwt mode a key without one opens nothing.
ACCOUNT_OPTION = "mirage-account"

# The connection's extra info a login the HTTPS route admitted carries its
# account under: the route checked the caller's token, so the login runs as
# the account it named, with no key and so no ACCOUNT_OPTION.
ROUTE_ACCOUNT = "mirage_route_account"

# A client that answers no keepalive for this many intervals is gone,
# so its connection closes and the line it was running is cancelled
# rather than left behind a half-open socket.
KEEPALIVE_INTERVAL_SECONDS = 15
KEEPALIVE_COUNT_MAX = 3

# The subsystem Codex opens (`ssh ... -s codex-exec`) to run its tools in
# a workspace. It speaks Codex's exec-server protocol: one JSON-RPC
# message per line, without the `jsonrpc` member.
CODEX_SUBSYSTEM = "codex-exec"
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
# The status the protocol reports for a terminated process: none.
CODEX_TERMINATED = -1

SSH_ENV_KEYS = {
    "ssh_port": ENV_SSH_PORT,
    "ssh_host": ENV_SSH_HOST,
    "ssh_host_key_file": ENV_SSH_HOST_KEY_FILE,
    "ssh_authorized_keys": ENV_SSH_AUTHORIZED_KEYS,
}
