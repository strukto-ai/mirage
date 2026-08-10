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

from typing import Any

# The interpreter-init switches, keyed by CPython's own letter. These
# configure the interpreter rather than selecting what it runs, so they
# ride in RunArgs.flags and each engine answers the ones it can. `-u`
# and `-q` are deliberately absent: mirage buffers every stream and
# prints no banner, so they are structural no-ops in every runtime
# rather than something one engine honors and another does not.
BOOL_FLAGS: tuple[str, ...] = ("B", "E", "I", "s", "S")
LIST_FLAGS: tuple[str, ...] = ("W", "X")
OPTIMIZE_FLAG = "O"


def init_argv(flags: dict[str, Any]) -> list[str]:
    """CPython command-line switches for one run's interpreter flags.

    For the engines that spawn a real interpreter, honoring these is
    just handing them back to CPython in its own spelling. ``-O``
    repeats rather than taking a number, so level 2 is ``-O -O``, which
    CPython reads exactly as ``-OO``.

    Args:
        flags (dict[str, Any]): the run's RunArgs.flags bag.
    """
    argv: list[str] = []
    for key in BOOL_FLAGS:
        if flags.get(key):
            argv.append(f"-{key}")
    level = flags.get(OPTIMIZE_FLAG) or 0
    argv.extend([f"-{OPTIMIZE_FLAG}"] * int(level))
    for key in LIST_FLAGS:
        for value in flags.get(key) or []:
            argv.extend([f"-{key}", value])
    return argv


def unhonored(flags: dict[str, Any]) -> list[str]:
    """The init switches present on a line, in CPython's spelling.

    A runtime that cannot act on these reports them rather than
    dropping them silently, so a line behaving differently across
    runtimes says so instead of being discovered later.

    Args:
        flags (dict[str, Any]): the run's RunArgs.flags bag.
    """
    present: list[str] = []
    for key in (*BOOL_FLAGS, OPTIMIZE_FLAG, *LIST_FLAGS):
        if flags.get(key):
            present.append(f"-{key}")
    return present


def unhonored_notice(flags: dict[str, Any], runtime_name: str) -> bytes:
    """One stderr line per init switch this runtime cannot act on.

    A warning rather than a refusal: the line still runs and still
    reports the program's own exit code, so a script that works on
    every other runtime keeps working here, while the difference stays
    visible instead of being found later.

    Args:
        flags (dict[str, Any]): the run's RunArgs.flags bag.
        runtime_name (str): the engine's registry name, for the message.
    """
    lines = [
        f"python3: warning: {spelling} is ignored by the "
        f"{runtime_name!r} runtime\n" for spelling in unhonored(flags)
    ]
    return "".join(lines).encode()
