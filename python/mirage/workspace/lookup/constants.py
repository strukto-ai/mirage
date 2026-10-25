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

from mirage.commands.builtin.generic.grep import directories_action
from mirage.commands.builtin.generic.ls import link_mode
from mirage.commands.builtin.generic.rg import walks_descendant_mounts
from mirage.commands.builtin.generic.sed import sed_writes
from mirage.commands.spec import SPECS, parse_command, parse_to_kwargs
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.shell.constants import BUILTIN_GROUP
from mirage.shell.types import BuiltinGroup, ShellBuiltin
from mirage.types import LsLinkMode, PathSpec

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

# Commands with lstat semantics: they act on the symlink entry itself,
# so dispatch must not rewrite their operands through the link table.
# `stat` is here because GNU stat lstats, but it takes -L to dereference
# after all, which route's `dereferences` reads back out of the command
# line; `file`, `du` and `find` are the same shape.
#
# `tar` and `zip` are here for a different reason and deliberately carry
# no DEREFERENCE_FLAGS entry: they dereference too, but their planner
# has to be the one doing it. Rewriting the operand up here would hand
# the planner a target it can no longer tell was reached through a link,
# so `tar` could not store a symlink member at all and neither archiver
# could apply its own cross-mount refusal or ELOOP wording. tar's -h and
# zip's -y are read by the planner instead.
NO_FOLLOW_COMMANDS = frozenset(
    {
        "rm",
        "mv",
        "ln",
        "readlink",
        "rmdir",
        "unlink",
        "stat",
        "file",
        "du",
        "find",
        "tar",
        "zip",
    }
)

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

# Per-command option that turns a no-follow command back into a
# following one (GNU's -L), then the one that takes it back, the last of
# the two winning: `du -LP` does not follow, `du -PL` does, and so for
# file's -L and -h (file 5.46). Each is the option's dest in the
# command's spec, read off the parsed line, so a long spelling and its
# abbreviation count as the short one does (`stat --deref`).
DEREFERENCE_FLAGS: dict[str, tuple[str, ...]] = {
    "stat": ("dereference",),
    "file": ("L", "h"),
    "du": ("L", "P"),
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


def line_flags(
    name: str, words: Sequence[str | PathSpec]
) -> Mapping[str, FlagValue]:
    """The flags a builtin's own grammar reads off its words, as the
    executor will hand them to its handler; empty for a name with no
    builtin grammar. A wrapper reads as the program it runs.

    The facts below are read off this parse rather than scanned from the
    words, so an abbreviation, a long spelling, a valued option and an
    option's attached value all read as the handler will read them:
    ``grep --recur`` and ``grep -d recurse`` walk, ``grep -ephrase``
    does not.

    Args:
        name (str): command name.
        words (Sequence[str | PathSpec]): the command's raw words, name
            first.
    """
    runs, *first = EXEC_WRAPPERS.get(name, (name,))
    spec = SPECS.get(runs)
    if spec is None:
        return {}
    argv = [w if isinstance(w, str) else w.raw_path for w in words[1:]]
    return parse_to_kwargs(parse_command(spec, [*first, *argv], "/", runs))


def walks_mounts(name: str, flags: Mapping[str, FlagValue]) -> bool:
    """Whether a command's traversal enters the mounts below its
    operands; a wrapper walks as the program it runs.

    What the admission gate stamps as ``CommandContext.walks``, so a
    mount rule can speak on an ancestor operand, and what the executor's
    fan-out reruns in each descendant mount: one answer for both, so a
    line the fan-out carries into a mount is one its rule was asked
    about. ``du -x``, ``tree -x`` and ``rg --one-file-system`` keep to
    the operand's mount. ``tar`` and ``zip`` walk too but refuse to cross
    a mount boundary, so a mount rule has nothing to say about them.

    Args:
        name (str): command name.
        flags (Mapping[str, FlagValue]): the parsed flags
            (``line_flags``).
    """
    runs = EXEC_WRAPPERS.get(name, (name,))[0]
    if runs == "find":
        return True
    if runs == "rg":
        return walks_descendant_mounts(flags)
    if runs not in ("du", "tree", "ls", "grep"):
        return False
    fl = FlagView(flags, spec=SPECS[runs])
    if runs == "du":
        return not fl.as_bool("one_file_system")
    if runs == "tree":
        return not fl.as_bool("x")
    if runs == "ls":
        return fl.as_bool("recursive")
    return directories_action(fl) == "recurse"


def reads_subtrees(name: str, flags: Mapping[str, FlagValue]) -> bool:
    """Whether a command reads below the paths its words name: every
    walk, whether or not it crosses into the mounts below (``du -x``,
    ``rg --one-file-system`` read their own mount's subtree), plus the
    subtree readers that stop at a mount boundary (``tar -c``,
    ``zip -r``, ``cp -r``, ``cp -a``).

    What the whole-line gate reads: a runtime does its own walking where
    no entry gate follows, so a path rule that scopes such a command
    refuses the captured line instead of running it unguarded.

    Args:
        name (str): command name.
        flags (Mapping[str, FlagValue]): the parsed flags
            (``line_flags``).
    """
    runs = EXEC_WRAPPERS.get(name, (name,))[0]
    if runs in ("find", "du", "tree", "rg"):
        return True
    if runs in ("grep", "ls"):
        return walks_mounts(runs, flags)
    if name not in ("tar", "zip", "cp"):
        return False
    fl = FlagView(flags, spec=SPECS[name])
    if name == "tar":
        return fl.as_bool("create")
    if name == "zip":
        return fl.as_bool("r")
    return any(fl.as_bool(d) for d in ("r", "recursive", "archive"))


# The builtins whose declared write ``changes_files`` narrows by line.
_NARROWED_WRITES = frozenset(
    {
        "sort",
        "shuf",
        "iconv",
        "uniq",
        "xxd",
        "tee",
        "mktemp",
        "tar",
        "unzip",
        "gzip",
        "gunzip",
        "sed",
    }
)


def changes_files(name: str, words: Sequence[str | PathSpec]) -> bool:
    """Whether this run of a builtin may change files, read off its
    words: the narrowing of a builtin's declared ``write`` that its
    options make. ``sort -o``, ``shuf -o`` and ``iconv -o`` write their
    output file and ``uniq`` and ``xxd`` their second operand, which a
    pattern operand may name; ``sed``
    writes under ``-i``, a ``w`` file in its script or a script file
    (unread here, so assumed to); ``tar`` writes to create or extract,
    not to list or to extract to stdout; ``unzip`` writes unless it
    lists, tests or pipes; ``gzip`` and ``gunzip`` write a file operand
    unless ``-c`` or ``-t``; ``tee`` writes the files it names;
    ``mktemp -u`` creates nothing. Every other name may write whenever
    its handler declares so.

    Args:
        name (str): command name.
        words (Sequence[str | PathSpec]): the command's words, name
            first; an operand classified as a path carries whether it is
            a pattern still to expand.
    """
    if name not in _NARROWED_WRITES:
        return True
    spec = SPECS[name]
    argv = [w if isinstance(w, str) else w.raw_path for w in words[1:]]
    parsed = parse_command(spec, argv, "/", name)
    flags = parse_to_kwargs(parsed)
    fl = FlagView(flags, spec=spec)
    operands = len(parsed.args)
    if name in ("sort", "shuf", "iconv"):
        return fl.raw("output") is not None
    if name in ("uniq", "xxd"):
        # A pattern the backend expands may name the output file too; a
        # quoted name is no pattern.
        return operands > 1 or any(
            isinstance(w, PathSpec) and w.pattern is not None
            for w in words[1:]
        )
    if name == "tee":
        return operands > 0
    if name == "mktemp":
        return not fl.as_bool("dry_run")
    if name == "tar":
        return fl.as_bool("create") or (
            fl.as_bool("extract") and not fl.as_bool("to_stdout")
        )
    if name == "unzip":
        return not any(fl.as_bool(d) for d in ("args_l", "t", "v", "p", "Z"))
    if name == "gzip":
        return operands > 0 and not fl.as_bool("c")
    if name == "gunzip":
        return operands > 0 and not (fl.as_bool("c") or fl.as_bool("t"))
    return sed_writes(flags, parsed.texts())


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


def _last_link_option(
    words: list[str | PathSpec], policy: dict[str, bool]
) -> bool:
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
    options = DEREFERENCE_FLAGS.get(name)
    if options is None:
        return False
    fl = FlagView(line_flags(name, words), spec=SPECS[name])
    return fl.typed_order(*options)[-1:] == [options[0]]


def ls_link_mode(words: Sequence[str | PathSpec]) -> LsLinkMode:
    """Which command-line links an ``ls`` line resolves before it lists.

    Read off the parsed line rather than scanned, because ls's own rule
    turns on the last of several options, some of them valued and any of
    them abbreviated (``--cl``, ``--indicator-style=classify``); the rule
    itself is the ls generic's ``link_mode``.

    Args:
        words (Sequence[str | PathSpec]): the command's raw words, name
            first.
    """
    return link_mode(FlagView(line_flags("ls", words), spec=SPECS["ls"]))


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
    if name == "ls":
        # A link to a directory is resolved only once a stat has shown
        # where it leads, which the router does itself; what this answers
        # is whether the line may resolve one at all.
        return ls_link_mode(words) is not LsLinkMode.NONE
    if name in SELF_RESOLVING:
        return False
    return name not in NO_FOLLOW_COMMANDS or dereferences(name, words)
