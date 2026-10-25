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

from collections.abc import Mapping

from mirage.commands.spec.types import FlagValue

# The interpreter-init switches, keyed by CPython's own letter. These
# configure the interpreter rather than selecting what it runs, so they
# ride in ctx.flags and each engine answers the ones it can. `-q` is
# deliberately absent: mirage prints no banner, so it is a no-op in every
# runtime. `-u` is absent too, since only a spawned CPython buffers its
# output: init_argv hands it back there, and every other engine already
# hands each write over as it comes, so none reports it.
BOOL_FLAGS: tuple[str, ...] = ("B", "E", "I", "P", "s", "S")
COUNT_FLAGS: tuple[str, ...] = ("O", "b")
LIST_FLAGS: tuple[str, ...] = ("W", "X")
# The one init switch CPython spells long. Its key is the parser's
# canonical spelling rather than a letter, since it has none.
VALUE_FLAGS: dict[str, str] = {
    "check_hash_based_pycs": "--check-hash-based-pycs",
}

# The -X names CPython gives an effect beyond landing in sys._xoptions,
# so a warm interpreter that only populates that dict has not honored
# them. Every one is read out of the read-only sys.flags or installed at
# interpreter start (dev, utf8, warn_default_encoding, importtime,
# frozen_modules, cpu_count, no_debug_ranges, perf*, showrefcount) or
# needs a library call the engine does not make (faulthandler,
# int_max_str_digits, pycache_prefix, tracemalloc). An arbitrary name is
# deliberately absent: on CPython it does nothing but land in the dict
# either. Pinned against `python3 --help-xoptions` on 3.13.7.
X_EFFECTS: frozenset[str] = frozenset(
    {
        "cpu_count",
        "dev",
        "faulthandler",
        "frozen_modules",
        "importtime",
        "int_max_str_digits",
        "no_debug_ranges",
        "perf",
        "perf_jit",
        "pycache_prefix",
        "showrefcount",
        "tracemalloc",
        "utf8",
        "warn_default_encoding",
    }
)


def _count(value: FlagValue | None) -> int:
    """A counted switch's level; 0 when absent.

    Args:
        value (FlagValue | None): the switch's value.
    """
    return value if isinstance(value, int) else 0


def _words(value: FlagValue | None) -> list[str]:
    """A repeated switch's values; none when absent.

    Args:
        value (FlagValue | None): the switch's value.
    """
    return [str(item) for item in value] if isinstance(value, list) else []


def init_argv(flags: Mapping[str, FlagValue]) -> list[str]:
    """CPython command-line switches for one run's interpreter flags.

    For the engines that spawn a real interpreter, honoring these is
    just handing them back to CPython in its own spelling. ``-O`` and
    ``-b`` repeat rather than taking a number, so level 2 is ``-O -O``,
    which CPython reads exactly as ``-OO``. ``-u`` goes back first: a
    spawned CPython buffers stdout on a pipe, as it would anywhere.

    Args:
        flags (Mapping[str, FlagValue]): the run's interpreter switches
            (``ctx.flags``).
    """
    argv: list[str] = ["-u"] if flags.get("u") else []
    for key in BOOL_FLAGS:
        if flags.get(key):
            argv.append(f"-{key}")
    for key in COUNT_FLAGS:
        argv.extend([f"-{key}"] * _count(flags.get(key)))
    for key in LIST_FLAGS:
        for value in _words(flags.get(key)):
            argv.extend([f"-{key}", value])
    for key, spelling in VALUE_FLAGS.items():
        setting = flags.get(key)
        if setting:
            # CPython parses this one by hand and rejects --opt=value,
            # so it goes back as two words whatever the user typed.
            argv.extend([spelling, str(setting)])
    return argv


def unhonored(
    flags: Mapping[str, FlagValue],
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
        flags (Mapping[str, FlagValue]): the run's interpreter switches
            (``ctx.flags``).
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
    # Reported per name rather than per letter: an engine can honor what
    # -X means for sys._xoptions and still not act on the handful of
    # names CPython gives a real effect.
    for value in _words(flags.get("X")):
        opt_name = value.split("=")[0]
        if opt_name in X_EFFECTS and f"X:{opt_name}" not in honored:
            present.append(f"-X {opt_name}")
    return present


def unhonored_notice(
    flags: Mapping[str, FlagValue],
    runtime_name: str,
    honored: tuple[str, ...] = (),
) -> bytes:
    """One stderr line per init switch this runtime cannot act on.

    A warning rather than a refusal: the line still runs and still
    reports the program's own exit code, so a script that works on
    every other runtime keeps working here, while the difference stays
    visible instead of being found later.

    Args:
        flags (Mapping[str, FlagValue]): the run's interpreter switches
            (``ctx.flags``).
        runtime_name (str): the engine's registry name, for the message.
        honored (tuple[str, ...]): the letters this engine does act on.
    """
    lines = [
        f"python3: warning: {spelling} is ignored by the "
        f"{runtime_name!r} runtime\n"
        for spelling in unhonored(flags, honored)
    ]
    return "".join(lines).encode()
