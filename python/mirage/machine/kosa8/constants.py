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

# Where kosa8 Cloud answers, and the variables that name it and the key.
DEFAULT_API_URL = "https://api.kosa8.com"
API_KEY_ENV = "KOSA8_API_KEY"
API_URL_ENV = "KOSA8_CLOUD_URL"

ON_PAUSE: tuple[PauseAction, ...] = ("pause",)

# Seconds a sandbox Mirage started stays awake once nothing runs there
# before kosa8 puts it to sleep; the next line wakes it. kosa8 counts only
# idle time with no process busy, so a running program keeps it awake.
IDLE_TIMEOUT_SECONDS = 60

# What kosa8 takes in one exec: at most this many argv entries, each at
# most this many characters. A longer line is staged as a script.
EXEC_ARGS_MAX = 256
EXEC_ARG_CHARS = 8192

# The most input a line may be given. kosa8's exec takes no stdin, so the
# input is uploaded whole to a file the program reads, and a program
# starts once its input has ended.
INPUT_LIMIT_BYTES = 64 * 1024 * 1024

# How long a request other than an exec's stream may take, in seconds.
REQUEST_TIMEOUT_SECONDS = 60.0

# How long an exec's stream may stay silent: kosa8 sends a heartbeat while
# the command runs quietly, so a longer silence is a lost connection.
STREAM_QUIET_SECONDS = 120.0

# How long Mirage waits for a sandbox it started to run, and how often it
# asks meanwhile, in seconds.
START_WAIT_SECONDS = 300.0
START_POLL_SECONDS = 1.0

# What every line runs under: ``$1`` is a file to read as stdin, removed
# once open (empty for none, which reads /dev/null); ``$2`` the working
# directory (exit 126 when the machine lacks it); then the program.
PRELUDE = (
    'if [ -n "$1" ]; then exec <"$1" || exit 126; rm -f -- "$1"; '
    "else exec </dev/null; fi; shift; "
    'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"'
)

# What a staged script is run as: it removes itself once sh has it open.
STAGED_HEAD = 'rm -f -- "$0"; exec '

# The kosa8 states a sandbox Mirage cannot run a line on, and what to do.
_SANDBOX_FIX = "create a new sandbox and set the machine's sandbox_id to it"
SANDBOX_GONE = {
    "deleted": f"it was deleted or never existed; {_SANDBOX_FIX}",
    "error": f"it failed to start; {_SANDBOX_FIX}",
    "stopped": f"it was stopped; {_SANDBOX_FIX}",
}
