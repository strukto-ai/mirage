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

# Numeric shorthand token like `-5` (head/tail count), never a flag
# cluster or a path.
NUMERIC_SHORT = re.compile(r"^-\d+$")

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
    "tar": 64,
}

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
