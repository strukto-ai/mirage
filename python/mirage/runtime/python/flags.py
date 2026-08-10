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
BOOL_FLAGS: tuple[str, ...] = ("B", "E", "I", "P", "s", "S")
COUNT_FLAGS: tuple[str, ...] = ("O", "b")
LIST_FLAGS: tuple[str, ...] = ("W", "X")
# The one init switch CPython spells long. Its key is the parser's
# canonical spelling rather than a letter, since it has none.
VALUE_FLAGS: dict[str, str] = {
    "check_hash_based_pycs": "--check-hash-based-pycs",
}


def init_argv(flags: dict[str, Any]) -> list[str]:
    """CPython command-line switches for one run's interpreter flags.

    For the engines that spawn a real interpreter, honoring these is
    just handing them back to CPython in its own spelling. ``-O`` and
    ``-b`` repeat rather than taking a number, so level 2 is ``-O -O``,
    which CPython reads exactly as ``-OO``.

    Args:
        flags (dict[str, Any]): the run's RunArgs.flags bag.
    """
    argv: list[str] = []
    for key in BOOL_FLAGS:
        if flags.get(key):
            argv.append(f"-{key}")
    for key in COUNT_FLAGS:
        argv.extend([f"-{key}"] * int(flags.get(key) or 0))
    for key in LIST_FLAGS:
        for value in flags.get(key) or []:
            argv.extend([f"-{key}", value])
    for key, spelling in VALUE_FLAGS.items():
        value = flags.get(key)
        if value:
            # CPython parses this one by hand and rejects --opt=value,
            # so it goes back as two words whatever the user typed.
            argv.extend([spelling, str(value)])
    return argv


def unhonored(
        flags: dict[str, Any],
        honored: tuple[str, ...] = (),
) -> list[str]:
    """The init switches on a line that this engine did not act on.

    A runtime that cannot act on these reports them rather than
    dropping them silently, so a line behaving differently across
    runtimes says so instead of being discovered later. ``honored`` is
    the engine's own subset, by CPython letter; the default is none,
    which is the honest answer for an engine that is not CPython at
    all.

    Args:
        flags (dict[str, Any]): the run's RunArgs.flags bag.
        honored (tuple[str, ...]): the letters this engine does act on.
    """
    present: list[str] = []
    for key in (*BOOL_FLAGS, *COUNT_FLAGS, *LIST_FLAGS):
        if key in honored:
            continue
        if flags.get(key):
            present.append(f"-{key}")
    for key, spelling in VALUE_FLAGS.items():
        if key not in honored and flags.get(key):
            present.append(spelling)
    return present


def unhonored_notice(
        flags: dict[str, Any],
        runtime_name: str,
        honored: tuple[str, ...] = (),
) -> bytes:
    """One stderr line per init switch this runtime cannot act on.

    A warning rather than a refusal: the line still runs and still
    reports the program's own exit code, so a script that works on
    every other runtime keeps working here, while the difference stays
    visible instead of being found later.

    Args:
        flags (dict[str, Any]): the run's RunArgs.flags bag.
        runtime_name (str): the engine's registry name, for the message.
        honored (tuple[str, ...]): the letters this engine does act on.
    """
    lines = [
        f"python3: warning: {spelling} is ignored by the "
        f"{runtime_name!r} runtime\n"
        for spelling in unhonored(flags, honored)
    ]
    return "".join(lines).encode()
