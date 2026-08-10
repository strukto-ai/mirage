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

from mirage.commands.spec import SPECS
from mirage.commands.spec.compile import compile_spec
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

# Options whose argument is a program, so the words after it are that
# program's argv rather than the command's own: python3's -c and -m
# (`python3 -c 'code' -u x` hands -u to the code). This is a table
# rather than a spec field on purpose. argparse cannot express it at
# all (`add_argument("-c")` beside `nargs=REMAINDER` answers
# `unrecognized arguments: -u`), and CPython parses its own command
# line in C for the same reason, so it is one command's rule and not
# part of the shared grammar.
PROGRAM_OPTIONS: dict[str, tuple[str, ...]] = {
    "python": ("-c", "-m"),
    "python3": ("-c", "-m"),
}


def end_options_after_program(name: str, words: list[str]) -> list[str]:
    """Insert POSIX's ``--`` after a program-carrying option's value.

    The handoff already has a spelling every parser honors, so the rule
    is applied by writing one down rather than by teaching the parser a
    new kind of option. The marker is inserted unconditionally, never
    skipped because the line already carries one: CPython stops parsing
    at ``-c`` and passes a later ``--`` through as data
    (``python3 -c p -- -u`` gives the program ``['-c', '--', '-u']``),
    so the parser must consume exactly the one added here and leave any
    typed one alone.

    Only the option run before the first operand is scanned. A ``-c``
    after an operand belongs to the program (``python3 s.py -c x``), and
    the operand already ended option parsing by itself.

    Args:
        name (str): the command name as routed.
        words (list[str]): the command's words, argv[0] excluded.
    """
    carriers = PROGRAM_OPTIONS.get(name)
    if carriers is None:
        return words
    # Value spellings say which words carry a value, so `-W ignore -c p`
    # steps over `ignore` instead of reading it as the first operand.
    value_spellings = compile_spec(SPECS[name]).value_spellings
    i = 0
    while i < len(words):
        word = words[i]
        if word == "--":
            return words
        carrier = next((c for c in carriers if word.startswith(c)), None)
        if carrier is not None:
            # Attached (`-cCODE`) carries its value in this word; the
            # detached form takes the next one.
            after = i + 1 if word != carrier else i + 2
            if after >= len(words):
                # Nothing to hand over, and a detached form with no value
                # at all is the parser's refusal to report, not ours to
                # turn into a program named `--`.
                return words
            return words[:after] + ["--"] + words[after:]
        if word in value_spellings:
            i += 2
            continue
        if word.startswith("-") and word != "-":
            i += 1
            continue
        return words
    return words


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
