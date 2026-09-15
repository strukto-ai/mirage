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

import re

AMBIGUOUS_NAMES = {"l": "args_l", "O": "args_O", "I": "args_I", "1": "args_1"}

# Stand-in name for a required operand whose slot declares none, so a
# refusal that has to name the slot always has a word for it. Bare like
# every operand name: the brackets are the renderer's.
ARG_PLACEHOLDER = "ARG"

# Numeric shorthand token like `-5` (head/tail count), never a flag
# cluster or a path.
NUMERIC_SHORT = re.compile(r"^-[0-9]+$")

# GNU echo is not getopt, so its option surface is a word shape, not a
# CommandSpec: options are LEADING words matching this pattern only.
ECHO_OPTION = re.compile(r"-[neE]+")

# Value shapes accepted by int- and float-typed options: the portable
# core of Python int()/float() and argparse (no whitespace, underscores,
# inf, or nan, so both languages accept exactly the same strings).
# [0-9] and not \d: python's \d also matches Unicode digits, which
# JS /\d/ and GNU's C-locale parsers reject.
INT_VALUE = re.compile(r"^[+-]?[0-9]+$")
FLOAT_VALUE = re.compile(
    r"^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$")

# GNU usage-error exit codes, pinned against debian coreutils/grep/diffutils
# (plus ripgrep and jq upstream docs). Everything else exits 1. Keys are
# plain strings, not CommandName members: types.py (the enum's home)
# imports this module for flag_kwarg_name, so importing the enum here
# would be a cycle; StrEnum members hash as their values, so lookups
# with CommandName still hit.
USAGE_EXIT = {
    "grep": 2,
    "egrep": 2,
    "fgrep": 2,
    "zgrep": 2,
    "rg": 2,
    "ls": 2,
    "sort": 2,
    "diff": 2,
    "cmp": 2,
    "awk": 2,
    "jq": 2,
    "curl": 2,
    "tar": 64,
    "python": 2,
    "python3": 2,
}

# The exit code a command answers when it cannot read an operand. GNU's
# code belongs to the COMMAND, not to the errno: `sort nope` and
# `sort dir` are both 2, `cat` is 1 for both. Absent means 1, which is
# what the executor's catch-all already did on its own. Pinned on
# debian:stable-slim (coreutils 9.7, GNU sed 4.9, gzip 1.13, jq 1.7,
# binutils 2.44, util-linux 2.41.5, bsdmainutils 12.1.8, xxd from
# vim-common). Plain strings for the same no-cycle reason as USAGE_EXIT.
READ_FAIL_EXIT = {
    "sort": 2,
    "awk": 2,
    "jq": 2,
    "xxd": 2,
    "grep": 2,
    "egrep": 2,
    "fgrep": 2,
    "rg": 2,
    "cmp": 2,
    "diff": 2,
    "sed": 2,
    "zgrep": 2,
    "unzip": 9,
}

# The four commands whose code DOES depend on the errno, so the table
# above cannot express them on its own. sed opens the directory
# successfully and fails on the read, which is its own class (4), while a
# missing file fails at open (2). The gzip family reports a directory as
# a warning (2) and a missing file as an error (1). zgrep inverts that,
# because its exit code is grep's: a directory it cannot decompress
# yields no match (1) where a missing file is grep's own error (2).
READ_FAIL_EXIT_ISDIR = {
    "sed": 4,
    "gzip": 2,
    "gunzip": 2,
    "zcat": 2,
    "zgrep": 1,
}

# The exit code of a command refused on one operand before it ran (an
# admission policy's operand-scoped Deny): 1 for the GNU tools, which
# report an operand they cannot act on and exit 1, and tar's own fatal
# code, since tar reports an operand it cannot open and exits 2 (GNU
# tar 1.35, `Exiting with failure status due to previous errors`).
# Plain strings for the same no-cycle reason as USAGE_EXIT.
OPERAND_EXIT = {
    "tar": 2,
}

# The interpreter commands answer option errors in CPython's words, not
# GNU's: python3 is not a GNU tool, and its refusal names the
# source-selecting options a reader needs. Plain strings for the same
# no-cycle reason as USAGE_EXIT above.
PYTHON_NAMES = frozenset({"python", "python3"})

# Pinned on CPython 3.12.13, including two quirks worth keeping: the
# hint always spells the program `python` (never `python3`, whichever
# way it was invoked), and it quotes with a backquote/quote pair.
PYTHON_USAGE = ("usage: {name} [option] ... [-c cmd | -m mod | file | -] "
                "[arg] ...\nTry `python -h' for more information.\n")

# An old-style cluster letter left without its argument exits 2, not
# USAGE_EXIT's 64: tar reads the cluster itself and raises its own fatal
# error, while 64 (EX_USAGE) is what argp returns for a letter it does
# not know. Pinned on GNU tar 1.35: `tar xzf` is 2, `tar -Q` is 64.
OLD_OPTION_EXIT = 2

# Commands whose `Try '--help'` hint line is prefixed with the command
# name (GNU diffutils style: `diff: Try 'diff --help' ...`).
USAGE_HINT_PREFIX = frozenset({"diff", "cmp"})


def flag_kwarg_name(flag: str) -> str:
    """Map a flag name to its dispatcher kwarg name.

    Args:
        flag (str): flag name with or without leading dashes.
    """
    clean = flag.lstrip("-").replace("-", "_")
    return AMBIGUOUS_NAMES.get(clean, clean)
