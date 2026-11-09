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

from mirage.machine.constants import is_run

RUN_PROGRAM_AT = 7

MICROSANDBOX_HINT = (
    "the microsandbox machine needs `msb` on PATH "
    "(https://microsandbox.dev); start the sandbox before connecting"
)

RUNNING_STATE = "Running"
INSPECT_TIMEOUT_SECONDS = 10

# msb ends the session of an exec whose client goes, and a run's exec is let
# go once its program has ended, so a program leads a session of its own:
# what it left running stays, as on any machine. The run is not a group
# leader there, so setsid keeps its pid.
OWN_SESSION = (
    'command -v setsid >/dev/null 2>&1 && exec setsid "$@"; exec "$@"'
)


def own_session(argv: tuple[str, ...]) -> tuple[str, ...]:
    """Start a run's program in a session of its own (``OWN_SESSION``).
    Mirage's own lines stay as they are.

    Args:
        argv (tuple[str, ...]): what the exec runs.
    """
    if not is_run(argv):
        return argv
    return (
        *argv[:RUN_PROGRAM_AT],
        "/bin/sh",
        "-c",
        OWN_SESSION,
        "sh",
        *argv[RUN_PROGRAM_AT:],
    )
