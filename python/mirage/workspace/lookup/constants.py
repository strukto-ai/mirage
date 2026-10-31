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

from collections.abc import Mapping, Sequence
from dataclasses import replace

from mirage.commands.builtin.generic.ls import link_mode
from mirage.commands.builtin.generic_bind.factory import declared_facts
from mirage.commands.spec import SPECS, parse_command, parse_to_kwargs
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue, WordKind
from mirage.shell.constants import BUILTIN_GROUP
from mirage.shell.types import BuiltinGroup, ShellBuiltin
from mirage.types import Follow, LineFacts, LsLinkMode, PathSpec

# Bash builtins the parser accepts but the executor cannot honor; they
# still route to the shell layer so the error names a capability gap.
UNSUPPORTED_BUILTINS = frozenset(
    {
        "bg",
        "complete",
        "compgen",
        "ulimit",
    }
)

NAMESPACE_COMMANDS = frozenset({"getfattr", "ln", "readlink", "setfattr"})

# Programs the router answers by name from the mount table and the attr
# overlay (node/command_dispatch), with spec-classified words like a
# mount command's. No mount registers them, so lookup names them here
# for `type`, `command -v` and the /usr/bin listing.
ROUTED_COMMANDS = frozenset({"chgrp", "chmod", "chown", "df", "mount"})

# The namespace and routed programs that change what they name. No mount
# registers them, so no handler declares the write; policy reads it here.
WRITING_PROGRAMS = frozenset({"chgrp", "chmod", "chown", "ln", "setfattr"})

# The programs Debian ships as a script that runs another one with an option
# put first: egrep is `exec grep -E "$@"`, so grep is what parses the line
# and answers it, its refusals and --help included (grep 3.11, gzip 1.13).
# Each is a program wherever the one it runs is a mount command.
EXEC_WRAPPERS = {
    "egrep": ("grep", "-E"),
    "fgrep": ("grep", "-F"),
    "zegrep": ("zgrep", "-E"),
    "zfgrep": ("zgrep", "-F"),
}

# bash reserved words that mirage's grammar implements. The parser, not
# the executor, consumes them, so they never reach route; `type` reports
# them and the CLI registry refuses them as head words. `coproc` is omitted
# because its construct is not implemented.
KEYWORDS = frozenset(
    {
        "time",
        "if",
        "then",
        "else",
        "elif",
        "fi",
        "case",
        "esac",
        "for",
        "select",
        "while",
        "until",
        "do",
        "done",
        "in",
        "function",
        "{",
        "}",
        "!",
        "[[",
        "]]",
    }
)

# ShellBuiltin subset handled through the job table in the executor.
JOB_BUILTINS = frozenset({"wait", "fg", "kill", "jobs", "disown", "ps"})

SHELL_NAMES = frozenset(str(b) for b in ShellBuiltin) | UNSUPPORTED_BUILTINS

# bash 5.2's own builtins (`compgen -b` on debian:stable-slim). `type`
# calls one of these a shell builtin and `command -v` prints it bare,
# even where a program of the same name is on PATH too (echo, test,
# pwd); any other word mirage runs is a program, reported by its path.
BASH_BUILTINS = frozenset(
    {
        ".",
        ":",
        "[",
        "alias",
        "bg",
        "bind",
        "break",
        "builtin",
        "caller",
        "cd",
        "command",
        "compgen",
        "complete",
        "compopt",
        "continue",
        "declare",
        "dirs",
        "disown",
        "echo",
        "enable",
        "eval",
        "exec",
        "exit",
        "export",
        "false",
        "fc",
        "fg",
        "getopts",
        "hash",
        "help",
        "history",
        "jobs",
        "kill",
        "let",
        "local",
        "logout",
        "mapfile",
        "popd",
        "printf",
        "pushd",
        "pwd",
        "read",
        "readarray",
        "readonly",
        "return",
        "set",
        "shift",
        "shopt",
        "source",
        "suspend",
        "test",
        "times",
        "trap",
        "true",
        "type",
        "typeset",
        "ulimit",
        "umask",
        "unalias",
        "unset",
        "wait",
    }
)

# The builtins that are the shell's own, which no program loader can
# find: `find -exec` execs through execvp and sees nothing the shell
# defined, so these heads are `find: 'cd': No such file or directory`
# (findutils 4.10 on debian:stable-slim, where `kill` is bash's alone
# since procps is absent), while `echo`, `sh`, `xargs` or `python3` are
# programs there as well as builtins here.
SHELL_ONLY_BUILTINS = frozenset(
    {
        ".",
        ":",
        "alias",
        "bg",
        "break",
        "cd",
        "command",
        "compgen",
        "complete",
        "continue",
        "declare",
        "disown",
        "eval",
        "exec",
        "exit",
        "export",
        "fg",
        "getopts",
        "help",
        "history",
        "jobs",
        "kill",
        "let",
        "local",
        "mapfile",
        "read",
        "readarray",
        "readonly",
        "return",
        "set",
        "shift",
        "shopt",
        "source",
        "trap",
        "type",
        "typeset",
        "ulimit",
        "umask",
        "unalias",
        "unset",
        "wait",
    }
)

# Interpreter names select runtime adapters; session builtins stay in Mirage.
INTERPRETER_NAMES = frozenset(
    str(name)
    for name, group in BUILTIN_GROUP.items()
    if group is BuiltinGroup.INTERPRETERS
)

# Shell words a native runtime's captures can take from the session: the
# interpreters, and the process tools whose host programs see that
# runtime's own processes rather than mirage's managed runners.
CAPTURABLE_BUILTINS = INTERPRETER_NAMES | frozenset({"ps", "kill"})

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


def _cluster_handoff(
    word: str,
    index: int,
    carriers: tuple[str, ...],
    value_spellings: tuple[str, ...],
) -> int | None:
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
        rest = word[j + 1 :]
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
            return 1 if word[j + 1 :] else 2
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
            detached = "=" not in word and long_name in cs.long_value_spellings
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


# Commands that decide the last component for themselves, so the router
# resolves only the prefix for them. chmod/chown/chgrp read -h off their
# own line (GNU `chgrp -h ops link` writes the link, not its target),
# touch reads -h the same way, ln is creating the name in its second
# operand, readlink's whole subject is the link it was handed, and
# mkdir is naming something that must not exist yet -- resolving its
# last component would make `mkdir -p dangle` create the link's missing
# target where GNU answers "File exists". getfattr and setfattr read -h
# off their own line and hand the dispatcher the link or its target.
# A trailing slash still applies: these are lstat-by-default, not
# slash-proof (`touch dlink/` succeeds against the target directory,
# `touch flink/` is "Not a directory"), which is why they are separate
# from SLASH_KEEPS_LAST.
SELF_RESOLVING = {
    "chmod",
    "chown",
    "chgrp",
    "touch",
    "ln",
    "readlink",
    "mkdir",
    "getfattr",
    "setfattr",
}


def _ls_facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """An ls line resolves the command-line links ``link_mode`` says, and
    walks, and reads, below its operands under ``-R``.

    Args:
        fl (FlagView): the ls flag view.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    recursive = fl.as_bool("recursive")
    return LineFacts(
        follows=_LS_FOLLOWS[link_mode(fl)],
        walks=recursive,
        reads_subtree=recursive,
    )


_LS_FOLLOWS = {
    LsLinkMode.ALL: Follow.LAST,
    LsLinkMode.DIRECTORY: Follow.DIRECTORY,
    LsLinkMode.NONE: Follow.NONE,
}


def facts_of(
    name: str,
    flags: Mapping[str, FlagValue],
    operands: Sequence[str | PathSpec],
) -> LineFacts:
    """What a line of a builtin does, read off its parsed flags by the
    command's own facts; a wrapper does what the program it runs does.

    Args:
        name (str): command name.
        flags (Mapping[str, FlagValue]): the line's parsed flags.
        operands (Sequence[str | PathSpec]): its operands, in order.
    """
    runs = EXEC_WRAPPERS.get(name, (name,))[0]
    declared = _ls_facts if runs == "ls" else declared_facts(runs)
    if isinstance(declared, LineFacts):
        facts = declared
    else:
        facts = declared(FlagView(flags, spec=SPECS[runs]), operands)
    if name in SELF_RESOLVING:
        return replace(facts, follows=Follow.NONE)
    return facts


def line_facts(
    name: str, words: Sequence[str | PathSpec], cwd: str
) -> LineFacts:
    """What a command line does, read off its words by the command's own
    grammar and facts (``facts_of``), so an abbreviation, a long
    spelling and an option's attached value read as the handler will
    read them: ``grep --recur`` and ``grep -d recurse`` walk,
    ``grep -ephrase`` does not. A command that decides its operand's
    last component itself (``SELF_RESOLVING``) follows no link.

    Args:
        name (str): command name.
        words (Sequence[str | PathSpec]): the command's words, name
            first; an operand classified as a path carries whether it is
            a pattern still to expand.
        cwd (str): the working directory a path option's value
            (``mv -t``) resolves against.
    """
    runs, *first = EXEC_WRAPPERS.get(name, (name,))
    spec = SPECS.get(runs)
    if spec is None or (
        runs != "ls" and isinstance(declared_facts(runs), LineFacts)
    ):
        return facts_of(name, {}, ())
    typed = [*first, *words[1:]]
    argv = [w if isinstance(w, str) else w.raw_path for w in typed]
    parsed = parse_command(spec, argv, cwd, runs)
    operands = [
        typed[i]
        for i, role in enumerate(parsed.word_roles)
        if role is WordKind.OPERAND
    ]
    # The parse is keyed by the words, the cwd (which `mv -t` resolves
    # in) and the grammar; a fact reads beyond it only the name it was
    # typed as (a wrapper, a self-resolving command) and which operands
    # are patterns, never a path's value.
    key = (
        name,
        tuple(
            isinstance(w, PathSpec) and w.pattern is not None for w in operands
        ),
    )
    kept = parsed.facts.get(key)
    if kept is None:
        kept = facts_of(name, parse_to_kwargs(parsed), operands)
        parsed.facts[key] = kept
    return kept
