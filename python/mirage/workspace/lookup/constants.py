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

from collections.abc import Sequence

from mirage.commands.spec import SPECS
from mirage.commands.spec.compile import compile_spec
from mirage.types import PathSpec
from mirage.workspace.names import (JOB_BUILTINS, NAMESPACE_COMMANDS,
                                    NO_FOLLOW_COMMANDS, SHELL_NAMES,
                                    SHELL_ONLY_BUILTINS, UNSUPPORTED_BUILTINS)

# The pools live in workspace/names.py (a leaf shared with the CLI
# registry's collision rule); this module keeps lookup's public surface.
__all__ = [
    "JOB_BUILTINS",
    "NAMESPACE_COMMANDS",
    "NO_FOLLOW_COMMANDS",
    "SHELL_NAMES",
    "SHELL_ONLY_BUILTINS",
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


def _cluster_handoff(word: str, index: int, carriers: tuple[str, ...],
                     value_spellings: tuple[str, ...]) -> int | None:
    """Where a short cluster's program value ends, or None if it has one.

    Args:
        word (str): the option word, dash included.
        index (int): the word's position in the command's words.
        carriers (tuple[str, ...]): the spellings whose value is a
            program.
        value_spellings (tuple[str, ...]): every short spelling that
            takes a value.
    """
    for j in range(1, len(word)):
        letter = f"-{word[j]}"
        rest = word[j + 1:]
        if letter in carriers:
            # Attached (`-cCODE`) carries its value in this word; the
            # detached form takes the next one.
            return index + 1 if rest else index + 2
        if letter in value_spellings:
            return None
    return None


def _cluster_words(word: str, value_spellings: tuple[str, ...]) -> int:
    """How many words a short cluster with no program value consumes.

    Args:
        word (str): the option word, dash included.
        value_spellings (tuple[str, ...]): every short spelling that
            takes a value.
    """
    for j in range(1, len(word)):
        if f"-{word[j]}" in value_spellings:
            return 1 if word[j + 1:] else 2
    return 1


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

    The scan walks a short cluster letter by letter rather than matching
    the word's prefix, because the carrier need not be first: CPython
    reads ``python3 -uc 'p' -v`` and ``python3 -uc'p' -v`` the same way
    it reads the unclustered forms, handing ``-v`` to the program.

    Args:
        name (str): the command name as routed.
        words (list[str]): the command's words, argv[0] excluded.
    """
    carriers = PROGRAM_OPTIONS.get(name)
    if carriers is None:
        return words
    # Value spellings say which words carry a value, so `-W ignore -c p`
    # steps over `ignore` instead of reading it as the first operand.
    cs = compile_spec(SPECS[name])
    i = 0
    while i < len(words):
        word = words[i]
        if word == "--":
            return words
        if not word.startswith("-") or word == "-":
            # The first operand, which ended option parsing by itself.
            return words
        if word.startswith("--"):
            long_name = word.split("=", 1)[0]
            detached = ("=" not in word
                        and long_name in cs.long_value_spellings)
            i += 2 if detached else 1
            continue
        after = _cluster_handoff(word, i, carriers, cs.value_spellings)
        if after is None:
            i += _cluster_words(word, cs.value_spellings)
            continue
        if after >= len(words):
            # Nothing to hand over, and a detached form with no value at
            # all is the parser's refusal to report, not ours to turn
            # into a program named `--`.
            return words
        return words[:after] + ["--"] + words[after:]
    return words


# The mirror: flags that make a following command report the link
# itself. GNU ls dereferences a command-line symlink to a directory, but
# -l and -d suppress that and show the link's own row instead.
NO_FOLLOW_FLAGS = {"ls": ("ld", ())}

# Commands whose traversal descends into descendant mounts (the
# executor's fan-out reruns them per mount), always or under a flag.
# What the admission gate reads to stamp ``CommandContext.walks``, so a
# mount rule can speak on an ancestor operand. ``tar`` and ``zip`` walk
# too but refuse to cross a mount boundary, so they are deliberately
# absent: a mount rule has nothing to say about a walk that never
# enters it.
WALK_COMMANDS = frozenset({"find", "du", "tree", "rg"})
WALK_FLAGS = {"grep": ("rR", ("recursive", )), "ls": ("R", ("recursive", ))}

# Commands whose reads exceed the words the gate judged even inside one
# mount: the walkers above plus the subtree readers that stop at a
# mount boundary. What the whole-line gate reads: a runtime does its
# own walking where no entry gate follows, so a path rule that scopes
# such a command refuses the captured line instead of running it
# unguarded.
SUBTREE_READ_FLAGS = {
    "tar": ("c", ("create", )),
    "zip": ("r", ("recurse-paths", )),
    "cp": ("rR", ("recursive", )),
}


def walks_mounts(name: str, words: Sequence[str | PathSpec]) -> bool:
    """Whether a command's traversal enters descendant mounts.

    Args:
        name (str): command name.
        words (Sequence[str | PathSpec]): the command's raw words,
            name first.
    """
    if name in WALK_COMMANDS:
        return True
    spec = WALK_FLAGS.get(name)
    return spec is not None and _has_option(words, spec[0], spec[1])


def reads_subtrees(name: str, words: Sequence[str | PathSpec]) -> bool:
    """Whether a command reads below the paths its words name.

    Args:
        name (str): command name.
        words (Sequence[str | PathSpec]): the command's raw words,
            name first.
    """
    if walks_mounts(name, words):
        return True
    spec = SUBTREE_READ_FLAGS.get(name)
    return spec is not None and _has_option(words, spec[0], spec[1])


# Commands the router must not resolve the last component for, even
# under a trailing slash, because none of them acts on the link's
# target and each says so in its own words. GNU tar strips the slash
# and archives the link (`tar -cf a.tar dlink/` == `tar -cf a.tar
# dlink`; only -h descends). The four destructive ones refuse outright:
# `rm dlink/` is "Is a directory", `rm -r dlink/` and `mv dlink/ d` and
# `unlink dlink/` are "Not a directory", and `rmdir dlink/` has a
# message of its own, "Symbolic link not followed". Probed on GNU
# coreutils 9.4 / tar 1.35. mkdir is here for the same reason it is in
# SELF_RESOLVING: it lstats the name it is creating, so `mkdir -p
# dangle/` collides with the link exactly as `mkdir -p dangle` does.
# Info-ZIP is the counter-example and is
# deliberately absent: `zip -y -r a.zip dlink/` descends where
# `zip -y -r a.zip dlink` stores the link.
SLASH_KEEPS_LAST = {"tar", "rm", "rmdir", "mv", "unlink", "mkdir"}


def _has_option(words: Sequence[str | PathSpec], shorts: str,
                longs: tuple[str, ...]) -> bool:
    """Whether any of the given options appears among a command's words.

    Read off the command line rather than the parsed flags because
    operand rewriting happens before flag parsing. Only option words are
    inspected, so a format string like ``-c '%L'`` cannot trip it.

    Args:
        words (Sequence[str | PathSpec]): the command's raw words,
            name first.
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


# Commands that decide the last component for themselves, so the router
# resolves only the prefix for them. chmod/chown/chgrp read -h off their
# own line (GNU `chgrp -h ops link` writes the link, not its target),
# touch reads -h the same way, ln is creating the name in its second
# operand, readlink's whole subject is the link it was handed, and
# mkdir is naming something that must not exist yet -- resolving its
# last component would make `mkdir -p dangle` create the link's missing
# target where GNU answers "File exists".
# A trailing slash still applies: these are lstat-by-default, not
# slash-proof (`touch dlink/` succeeds against the target directory,
# `touch flink/` is "Not a directory"), which is why they are separate
# from SLASH_KEEPS_LAST.
SELF_RESOLVING = {
    "chmod", "chown", "chgrp", "touch", "ln", "readlink", "mkdir"
}


def follows_last_component(name: str, words: list[str | PathSpec]) -> bool:
    """Whether a command resolves its operand's final component itself.

    The directory prefix is resolved for every command, so this is only
    about the last one: open(2) semantics (True) against lstat(2)
    (False). A trailing slash overrides a False per operand, which is
    ``follow_paths``' job because the slash is a property of the operand
    rather than of the command.

    Args:
        name (str): command name.
        words (list[str | PathSpec]): the command's raw words.
    """
    if reports_link(name, words) or name in SELF_RESOLVING:
        return False
    return name not in NO_FOLLOW_COMMANDS or dereferences(name, words)
