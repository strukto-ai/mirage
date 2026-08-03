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

from mirage.types import PathSpec
from mirage.workspace.names import (JOB_BUILTINS, NAMESPACE_COMMANDS,
                                    NO_FOLLOW_COMMANDS, SHELL_NAMES,
                                    UNSUPPORTED_BUILTINS)

# The pools live in workspace/names.py (a leaf shared with the CLI
# registry's collision rule); this module keeps route's public surface.
__all__ = [
    "JOB_BUILTINS",
    "NAMESPACE_COMMANDS",
    "NO_FOLLOW_COMMANDS",
    "SHELL_NAMES",
    "UNSUPPORTED_BUILTINS",
]

# Per-command flags that turn a no-follow command back into a following
# one, GNU's -L / --dereference.
DEREFERENCE_FLAGS = {
    "stat": ("L", ("dereference", )),
    "ls": ("L", ("dereference", )),
    "file": ("L", ("dereference", )),
    "du": ("L", ("dereference", )),
}

# find states its link policy as a leading option rather than a flag, and
# the last one wins: `find -L -P x` does not follow, `find -P -L x` does.
# -P (no follow) is the default; -H dereferences the start point only and
# -L dereferences everything, so both follow the operand. Only the run of
# options before the first operand counts, which is where GNU accepts
# them.
LAST_WINS_LINK_OPTIONS = {"find": {"-P": False, "-H": True, "-L": True}}

# The mirror: flags that make a following command report the link
# itself. GNU ls dereferences a command-line symlink to a directory, but
# -l and -d suppress that and show the link's own row instead.
NO_FOLLOW_FLAGS = {"ls": ("ld", ())}


def _has_option(words: list[str | PathSpec], shorts: str,
                longs: tuple[str, ...]) -> bool:
    """Whether any of the given options appears among a command's words.

    Read off the command line rather than the parsed flags because
    operand rewriting happens before flag parsing. Only option words are
    inspected, so a format string like ``-c '%L'`` cannot trip it.

    Args:
        words (list[str | PathSpec]): the command's raw words, name first.
        shorts (str): short option letters, any of which counts.
        longs (tuple[str, ...]): long option names, without the dashes.
    """
    for word in words[1:]:
        # Option words are always plain strings; path operands arrive as
        # PathSpec and can never be a flag.
        if not isinstance(word, str):
            continue
        if word == "--":
            return False
        if word.startswith("--"):
            if word[2:] in longs:
                return True
            continue
        if word.startswith("-") and any(c in word[1:] for c in shorts):
            return True
    return False


def _last_link_option(words: list[str | PathSpec], policy: dict[str,
                                                                bool]) -> bool:
    """Resolve a leading run of link options to its last one's mode.

    Args:
        words (list[str | PathSpec]): the command's raw words, name first.
        policy (dict[str, bool]): option word to the follow mode it sets.
    """
    follows = False
    for word in words[1:]:
        if not isinstance(word, str) or word not in policy:
            break
        follows = policy[word]
    return follows


def dereferences(name: str, words: list[str | PathSpec]) -> bool:
    """Whether a no-follow command was asked to dereference after all.

    Args:
        name (str): command name.
        words (list[str | PathSpec]): the command's raw words.
    """
    policy = LAST_WINS_LINK_OPTIONS.get(name)
    if policy is not None:
        return _last_link_option(words, policy)
    spec = DEREFERENCE_FLAGS.get(name)
    return spec is not None and _has_option(words, spec[0], spec[1])


def reports_link(name: str, words: list[str | PathSpec]) -> bool:
    """Whether a following command was asked to report links themselves.

    Args:
        name (str): command name.
        words (list[str | PathSpec]): the command's raw words.
    """
    if dereferences(name, words):
        return False
    spec = NO_FOLLOW_FLAGS.get(name)
    return spec is not None and _has_option(words, spec[0], spec[1])
