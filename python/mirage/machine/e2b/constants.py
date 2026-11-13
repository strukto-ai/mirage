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

from mirage.machine.types import SleepAction

# A PTY carries a served prefix's SFTP where a provider's exec decodes
# output as text (E2B): the terminal goes raw, so bytes pass unchanged,
# and the marker ends the shell's own output before sshfs starts.
PTY_MARK = b"\x01mirage-sftp\x02"
PTY_RAW = "stty raw -echo -iexten; printf '\\001mirage-sftp\\002'; "

# envd reports a write to an input the command has closed (head) as the
# broken-pipe or closed-file text inside a generic INTERNAL error.
CLOSED_INPUT = ("broken pipe", "file already closed")

# What ``on_sleep`` takes for a sandbox: pause it, keeping its disk and
# memory.
ON_SLEEP: tuple[SleepAction, ...] = ("pause",)

# Why a sandbox the SDK says is gone cannot take a line, by how it said so,
# with the fix: the sandbox is the user's, and Mirage never makes one.
_SANDBOX_FIX = "create a new sandbox and set the machine's sandbox_id to it"
SANDBOX_GONE = {
    "deleted": (
        f"it was killed, reached its timeout or never existed; {_SANDBOX_FIX}"
    ),
    "ended": f"it was killed or reached its timeout; {_SANDBOX_FIX}",
}
