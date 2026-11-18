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

from mirage.machine.types import PauseAction

# A PTY carries a served prefix's SFTP where a provider's exec decodes
# output as text (E2B): the terminal goes raw, so bytes pass unchanged,
# and the marker ends the shell's own output before sshfs starts.
PTY_MARK = b"\x01mirage-sftp\x02"
PTY_RAW = "stty raw -echo -iexten; printf '\\001mirage-sftp\\002'; "

# envd reports a write to an input the command has closed (head) as the
# broken-pipe or closed-file text inside a generic INTERNAL error.
CLOSED_INPUT = ("broken pipe", "file already closed")

# What ``on_pause`` takes for a sandbox: pause it, keeping its disk and
# memory.
ON_PAUSE: tuple[PauseAction, ...] = ("pause",)

# The template a sandbox Mirage starts comes from when the config names
# none: E2B's own.
DEFAULT_TEMPLATE = "base"

# How long a sandbox Mirage started stays up while Mirage has work there
# before E2B pauses it itself, pushed out again every
# ``BUSY_REFRESH_SECONDS`` while the work lasts: a host that went away
# mid-run leaves it running this long at most.
BUSY_TIMEOUT_SECONDS = 10 * 60
BUSY_REFRESH_SECONDS = 5 * 60

# How long a sandbox Mirage started stays up once Mirage's work there ends,
# before E2B pauses it itself, when the config sets no ``idle_timeout``.
IDLE_TIMEOUT_SECONDS = 10

# How much sooner than its idle timeout a sandbox may have paused already:
# the time the timeout took to reach E2B.
IDLE_MARGIN_SECONDS = 1

# Why a sandbox the SDK says is gone cannot take a line, by how it said so,
# with the fix: the sandbox is the user's. One Mirage started is started
# anew.
_SANDBOX_FIX = "create a new sandbox and set the machine's sandbox_id to it"
SANDBOX_GONE = {
    "deleted": (
        f"it was killed, reached its timeout or never existed; {_SANDBOX_FIX}"
    ),
    "ended": f"it was killed or reached its timeout; {_SANDBOX_FIX}",
}
