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
from dataclasses import dataclass

from mirage.commands.spec.shell import SHELL_SPECS, parse_shell_options
from mirage.shell.helpers import get_text, literal_word
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.utils.fnmatch import pattern_shape
from mirage.utils.glob_walk import has_glob, mark_escaped_globs
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.executor.builtins.script.bash import parse_bash_args
from mirage.workspace.executor.builtins.script.constants import (
    BASH_LONG_OPTIONS,
)
from mirage.workspace.lookup.constants import read_wrapper
from mirage.workspace.lookup.lookup import lookup, path_program
from mirage.workspace.lookup.types import Consumer
from mirage.workspace.mount import MountRegistry
from mirage.workspace.node.test_tokens import (
    PATTERN_OPS,
    CondParser,
    cond_leaves,
    cond_tokens,
)
from mirage.workspace.session import SessionState


@dataclass(frozen=True, slots=True)
class Word:
    """One word of a line as the gate reads it.

    Args:
        raw (str): the word as typed.
        text (str | None): what it names before expansion (quotes
            removed, escapes resolved); None when only the runtime can
            say, a parameter or command substitution or a brace
            expansion.
        glob (bool): whether an unquoted pathname pattern may erase or
            multiply this word when the runtime expands it.
    """

    raw: str
    text: str | None
    glob: bool = False

    @property
    def value(self) -> str:
        """The text the gate works with: the literal when it has one,
        the word as typed otherwise."""
        return self.text if self.text is not None else self.raw


def _word_globs(node: TSNodeLike) -> bool:
    if node.type in (NT.WORD, NT.NUMBER):
        return has_glob(pattern_shape(mark_escaped_globs(get_text(node))))
    if node.type in (NT.COMMAND_NAME, NT.CONCATENATION):
        return any(_word_globs(child) for child in node.named_children)
    return node.type == NT.EXTGLOB_PATTERN


def read_word(
    node: TSNodeLike,
    homes: Mapping[str, str] | None = None,
    globs: bool = True,
) -> Word:
    """Read a word without losing which glob characters are quoted.

    Args:
        node (TSNodeLike): the command word's syntax node.
        homes (Mapping[str, str] | None): the homes each ``~name``
            names, ``""`` for a bare ``~``.
        globs (bool): whether the runtime expands pathname patterns in
            this word; inside ``[[ ]]`` it never does.
    """
    return Word(
        get_text(node), literal_word(node, homes), globs and _word_globs(node)
    )


@dataclass(frozen=True, slots=True)
class TestRead:
    """One test of a ``[ ]`` or ``[[ ]]`` as the gate admits it.

    Args:
        words (list[Word]): its opener, then what it tests.
        stated (bool): whether the gate admits it on these very words
            once each is literal; a comparison's pattern side is read in
            the matcher's dialect instead, so a question about one is
            left to the gate.
    """

    __test__ = False

    words: list[Word]
    stated: bool = True


def reads_of_test(
    node: TSNodeLike, homes: Mapping[str, str] | None = None
) -> list[TestRead]:
    """A ``[[ ]]`` as the tests the gate admits, read with the tokens and
    the grammar the run evaluates it by: a test per leaf, each admitted
    as the run reaches it, since a branch never reached never expands;
    every reader of the line reads the same leaves, so a question one
    asked is the one the gate answers. No word of it expands a pathname
    pattern, so none is a glob, and a pattern side with no expansion in
    it (an extglob or regex node) is matched as typed, so it names its
    own text. (``[`` is a command, admitted on its words as any command
    is.)

    Args:
        node (TSNodeLike): the test_command node.
        homes (Mapping[str, str] | None): the homes each ``~name``
            names, ``""`` for a bare ``~``.
    """
    opener = Word("[[", "[[")
    out: list[TestRead] = []
    for leaf in cond_leaves(CondParser(cond_tokens(node)).parse()):
        if leaf[0] == "unary":
            words = [
                Word(leaf[1], leaf[1]),
                read_word(leaf[2], homes, globs=False),
            ]
        elif leaf[0] == "binary":
            right = read_word(leaf[3], homes, globs=False)
            if leaf[3].type in (NT.EXTGLOB_PATTERN, NT.REGEX):
                right = Word(right.raw, right.raw)
            words = [
                read_word(leaf[2], homes, globs=False),
                Word(leaf[1], leaf[1]),
                right,
            ]
        else:
            words = [read_word(leaf[1], homes, globs=False)]
        stated = leaf[0] != "binary" or leaf[1] not in PATTERN_OPS
        out.append(TestRead([opener, *words], stated))
    return out


@dataclass(frozen=True, slots=True)
class InnerLine:
    """A line a command runs on the words it was given.

    Exactly one shape applies. ``line`` is text the runtime parses
    afresh (``eval``'s joined words, ``sh -c``'s program, ``mapfile
    -C``'s callback); ``argv`` is a command already split into words
    (``command``, ``exec``, ``env``, ``timeout``, ``xargs``, ``find
    -exec``, ``nohup``, ``nice``, ``time``); neither is a line the gate
    cannot read at all (a sourced file, a script, a program from
    stdin).

    Args:
        line (str | None): the text to parse.
        argv (tuple[Word, ...]): the command, name first.
        open (bool): whether the runtime appends operands the gate
            cannot read (``xargs``'s items, ``find``'s ``{}`` paths,
            the index and record ``mapfile -C`` hands its callback).
        chdir (Word | None): the folder the command runs in, as ``cd``
            would take it (``env -C``); None for the caller's own.
    """

    line: str | None = None
    argv: tuple[Word, ...] = ()
    open: bool = False
    chdir: Word | None = None

    @property
    def readable(self) -> bool:
        """Whether the gate can read what runs."""
        return self.line is not None or bool(self.argv)


_FIND_EXEC = frozenset({"-exec", "-execdir", "-ok", "-okdir"})
_ENV_FLAGS = frozenset({"-i", "--ignore-environment", "-0", "--null", "-"})
_ENV_VALUED = ("unset", "chdir", "argv0")
# Variables a whole line's shell expands or sources on its own.
HOOK_VARS = frozenset({"PS4", "BASH_ENV", "BASH_CMDS", "BASH_ALIASES"})


def is_hook(name: str) -> bool:
    """Whether a variable sets what a whole line's shell runs on its own:
    one it expands or sources (``HOOK_VARS``), or a function bash imports
    from the environment (``BASH_FUNC_NAME%%``).

    Args:
        name (str): the variable's name.
    """
    return name in HOOK_VARS or name.startswith("BASH_FUNC_")


def _tail(args: Sequence[Word], count: int) -> tuple[Word, ...]:
    return tuple(args[len(args) - count :]) if count else ()


def _command_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``command [-pVv] name [arg ...]``: ``-v``/``-V`` only report."""
    i = 0
    while i < len(args) and args[i].value.startswith("-"):
        word = args[i].value
        i += 1
        if word == "--":
            break
        if "v" in word or "V" in word:
            return []
    rest = tuple(args[i:])
    return [InnerLine(argv=rest)] if rest else []


def _exec_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``exec [-cl] [-a name] [command [arg ...]]``; ``-l``, or a name
    starting with ``-``, starts a shell as a login shell, which sources
    rc files the gate cannot read."""
    i = 0
    while i < len(args) and args[i].value.startswith("-"):
        word = args[i].value
        i += 1
        if word == "--":
            break
        if "l" in word:
            return [InnerLine()]
        if word.endswith("a"):
            if i < len(args) and args[i].value.startswith("-"):
                return [InnerLine()]
            i += 1
    rest = tuple(args[i:])
    return [InnerLine(argv=rest)] if rest else []


def _splits(word: str) -> bool:
    """Whether an ``env`` word is GNU's ``-S`` / ``--split-string``, whose
    value env splits into the command line itself.

    Args:
        word (str): one option word.
    """
    if word.startswith("--"):
        name = word[2:].split("=", 1)[0]
        return bool(name) and "split-string".startswith(name)
    if not word.startswith("-"):
        return False
    for flag in word[1:]:
        if flag == "S":
            return True
        if flag in "uCa":
            return False
    return False


def _takes_next(word: str) -> bool:
    """Whether an ``env`` option word takes the next word as its value:
    a detached ``--unset``, ``--chdir`` or ``--argv0`` (or a prefix of
    one), or a cluster whose first of ``u``, ``C``, ``a`` ends it, since
    getopt hands such a letter the rest of its cluster when there is one.

    Args:
        word (str): one option word.
    """
    if word.startswith("--"):
        name, eq, _ = word[2:].partition("=")
        return not eq and any(
            long.startswith(name) for long in _ENV_VALUED if name
        )
    for at, flag in enumerate(word[1:], 1):
        if flag in "uCa":
            return at == len(word) - 1
    return False


def _value_of(
    word: Word, after: Word | None, letter: str, long: str
) -> Word | None:
    """An ``env`` option word's value for ``-letter`` or ``--long``,
    attached or the next word; None for any other option.

    Args:
        word (Word): one option word.
        after (Word | None): the word after it.
        letter (str): the short option, ``C`` or ``a``.
        long (str): the long option, ``chdir`` or ``argv0``.
    """
    value = word.value
    if value.startswith("--"):
        name, eq, attached = value[2:].partition("=")
        if not name or not long.startswith(name):
            return None
        if not eq:
            return after
    else:
        at = next((at for at, f in enumerate(value) if f in "uCa"), 0)
        if not at or value[at] != letter:
            return None
        attached = value[at + 1 :]
        if not attached:
            return after
    return Word(attached, None if word.text is None else attached)


def _env_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``env [-i] [-u NAME]... [NAME=VALUE]... [command [arg]...]``,
    read the way the tree's ``env`` builtin reads it."""
    chdir: Word | None = None
    i = 0
    while i < len(args):
        word = args[i].value
        if word == "--":
            i += 1
            break
        if _splits(word):
            return [InnerLine()]
        if word in _ENV_FLAGS:
            i += 1
            continue
        if word.startswith("-") and len(word) > 1:
            after = args[i + 1] if i + 1 < len(args) else None
            chdir = _value_of(args[i], after, "C", "chdir") or chdir
            argv0 = _value_of(args[i], after, "a", "argv0")
            if argv0 is not None and argv0.value.startswith("-"):
                # A leading `-` in argv0 makes a shell a login shell.
                return [InnerLine()]
            i += 2 if _takes_next(word) else 1
            continue
        break
    while (
        i < len(args)
        and "=" in args[i].value
        and not args[i].value.startswith("=")
    ):
        if is_hook(args[i].value.partition("=")[0]):
            return [InnerLine()]
        i += 1
    rest = tuple(args[i:])
    return [InnerLine(argv=rest, chdir=chdir)] if rest else []


def _spec_operands(name: str, args: Sequence[Word]) -> tuple[Word, ...] | None:
    """The operands of a shell builtin with a spec, as Words; None
    when the line fails its own option parse."""
    parsed = parse_shell_options(SHELL_SPECS[name], [w.value for w in args])
    if (
        parsed.invalid is not None
        or parsed.needs_value is not None
        or parsed.unexpected_value is not None
    ):
        return None
    return _tail(args, len(parsed.operands))


def _timeout_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``timeout [OPTION] DURATION COMMAND [ARG]...``."""
    operands = _spec_operands("timeout", args)
    if operands is None or len(operands) < 2:
        return []
    return [InnerLine(argv=operands[1:])]


def _xargs_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``xargs [OPTION]... [COMMAND [INITIAL-ARGS]]``, ``echo`` when
    none, items from stdin appended."""
    operands = _spec_operands("xargs", args)
    if operands is None:
        return []
    argv = operands or (Word("echo", "echo"),)
    return [InnerLine(argv=argv, open=True)]


def _mapfile_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``mapfile -C callback``: the callback is evaluated per quantum."""
    parsed = parse_shell_options(
        SHELL_SPECS["mapfile"], [w.value for w in args]
    )
    callback = parsed.flags.get("C")
    return (
        [InnerLine(line=callback, open=True)]
        if isinstance(callback, str)
        else []
    )


def _find_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``find ... -exec COMMAND [ARG]... ;`` (and ``-execdir``, ``-ok``,
    ``-okdir``, ``+``), the matched paths appended."""
    inner: list[InnerLine] = []
    i = 0
    while i < len(args):
        if args[i].value not in _FIND_EXEC:
            i += 1
            continue
        i += 1
        start = i
        while i < len(args) and args[i].value not in (";", "+"):
            i += 1
        words = tuple(args[start:i])
        if words:
            inner.append(InnerLine(argv=words, open=True))
    return inner


def _wrapper_inner(head: str, args: Sequence[Word]) -> list[InnerLine]:
    """``nohup``, ``nice``, ``stdbuf``, ``setsid`` and ``ionice`` run what
    stands after their own options.

    Args:
        head (str): the wrapper.
        args (Sequence[Word]): the words after it.
    """
    at = read_wrapper(head, [word.value for word in args])[0]
    return [] if at is None else [InnerLine(argv=tuple(args[at:]))]


def _time_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``time [-p] COMMAND [ARG]...``."""
    i = 0
    while i < len(args) and args[i].value in ("-p", "--"):
        i += 1
    rest = tuple(args[i:])
    return [InnerLine(argv=rest)] if rest else []


def _trap_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``trap [-lp] [[ACTION] CONDITION...]``: the action is a line the
    shell runs when a condition fires. ``-`` or a number first resets the
    conditions, a lone operand resets it, and an option only lists.

    Args:
        args (Sequence[Word]): the words after ``trap``.
    """
    first = args[0].value if args else ""
    if first.startswith("-") and first not in ("-", "--"):
        return []
    rest = args[1:] if first == "--" else args
    action = rest[0].value if rest else ""
    if len(rest) < 2 or action == "-" or action.isascii() and action.isdigit():
        return []
    return [InnerLine(line=rest[0].value)]


def _loads(args: Sequence[Word], letter: str) -> list[InnerLine]:
    """A builtin whose option ``letter`` loads what a later word runs from
    a file the gate cannot read (``hash -p``, ``enable -f``).

    Args:
        args (Sequence[Word]): the words after the builtin.
        letter (str): the loading option.
    """
    for word in args:
        if word.value == "--" or not word.value.startswith("-"):
            break
        if letter in word.value[1:]:
            return [InnerLine()]
    return []


def _argv_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``builtin`` runs the remaining words verbatim, after an optional
    leading ``--``.

    Args:
        args (Sequence[Word]): the words after the wrapper command.
    """
    rest = tuple(args[1:] if args and args[0].value == "--" else args)
    return [InnerLine(argv=rest)] if rest else []


def _starts_rc(words: Sequence[str]) -> bool:
    """Whether a shell's startup options make it interactive or a login
    shell (``-i``, ``-l``, ``--login``), which sources rc files (``ENV``,
    ``~/.bashrc``, ``~/.profile``) the gate cannot read.

    Args:
        words (Sequence[str]): the words after ``sh`` or ``bash``.
    """
    skip = False
    for word in words:
        if skip:
            skip = False
            continue
        if word in ("-", "--") or not word.startswith("-"):
            return False
        if word.startswith("--"):
            if word == "--login":
                return True
            skip = bool(BASH_LONG_OPTIONS.get(word[2:]))
            continue
        if "i" in word or "l" in word:
            return True
        if "c" in word:
            return False
        skip = word[-1] in "oO"
    return False


def _shell_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``sh``/``bash``: ``-c`` names the program and ``--help`` or
    ``--version`` runs nothing; a script file, a program read from stdin
    and a line mirage's parse refuses are lines the gate cannot read,
    since a real bash takes options mirage does not (``--restricted``,
    ``-O extglob``) and still runs the program."""
    # Expansion can erase or split a word, shifting an option's value
    # onto --version or -c. Only a literal prefix can establish what
    # runs; dynamic positional words after its program cannot change it.
    literal: list[str] = []
    for word in args:
        if word.text is None or word.glob:
            break
        literal.append(word.text)
    if _starts_rc(literal):
        return [InnerLine()]
    parsed = parse_bash_args(literal)
    if parsed.help or parsed.version:
        return []
    if parsed.script is not None and parsed.script.startswith("-"):
        # bash reads options after `-c` up to the program; mirage's parse
        # takes the next word.
        return [InnerLine()]
    if parsed.script is not None:
        return [InnerLine(line=parsed.script)]
    return [InnerLine()]


def inner_lines(head: str, args: Sequence[Word]) -> list[InnerLine]:
    """The lines a command runs on the words it was given, for the
    words that run other words.

    The table is the workspace shell's own re-dispatchers (every
    builtin that hands a constructed line back to the evaluator:
    ``eval``, ``source``, ``command``, ``env``, ``timeout``, ``xargs``,
    ``mapfile -C``, ``sh``/``bash``, an executed path) plus the classic
    prefix runners a real shell has and the workspace shell does not
    (``builtin``, ``exec``, ``nohup``, ``nice``, ``time``,
    ``find -exec``). A
    whole-line runtime is a real shell, so anything else that can run a
    command (an interpreter's ``-c``, ``make``, ``git`` hooks) is the
    runtime's own world: a closed tree is the closed form there.

    Args:
        head (str): the command name, as the gate reads it.
        args (Sequence[Word]): the words after it.
    """
    if "/" in head:
        return [InnerLine()]
    if head == "eval":
        return (
            [InnerLine(line=" ".join(w.value for w in args))] if args else []
        )
    if head in ("source", "."):
        return [InnerLine()] if args else []
    if head in ("sh", "bash"):
        return _shell_inner(args)
    if head == "command":
        return _command_inner(args)
    if head == "builtin":
        return _argv_inner(args)
    if head == "exec":
        return _exec_inner(args)
    if head == "env":
        return _env_inner(args)
    if head == "timeout":
        return _timeout_inner(args)
    if head == "xargs":
        return _xargs_inner(args)
    if head in ("mapfile", "readarray"):
        return _mapfile_inner(args)
    if head == "find":
        return _find_inner(args)
    if head in ("nohup", "nice", "stdbuf", "setsid", "ionice"):
        return _wrapper_inner(head, args)
    if head == "time":
        return _time_inner(args)
    if head == "trap":
        return _trap_inner(args)
    if head == "coproc":
        return [InnerLine(argv=tuple(args))] if args else []
    if head == "hash":
        return _loads(args, "p")
    if head == "enable":
        return _loads(args, "f")
    if head == "alias" and any(
        w.text is None
        or ("=" in w.value and not w.value.startswith(("=", "-")))
        for w in args
    ):
        # A whole line's shell expands a later word to the value.
        return [InnerLine()]
    return []


def program_lines(
    words: Sequence[Word],
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader | None = None,
    open_: bool = False,
) -> list[InnerLine]:
    """``inner_lines`` of a command, a ``/usr/bin`` path running its
    program on the words after it, as the plain path runs it
    (``/usr/bin/python3 -c 1`` runs ``python3 -c 1``).

    Args:
        words (Sequence[Word]): the command, name first.
        session (SessionState): the session (cwd, its programs).
        registry (MountRegistry): mount registry (the ``/usr/bin`` view).
        links (NamespaceReader | None): the session's links, followed
            to the file; None to read the path as typed.
        open_ (bool): whether the runtime appends operands the gate
            cannot read to the command (``xargs``), kept for its program.
    """
    head, args = words[0].value, words[1:]
    if runs_function(head, session, registry):
        return []
    program = path_program(head, session, registry, links)
    if program is None:
        return inner_lines(head, args)
    return [InnerLine(argv=(Word(program, program), *args), open=open_)]


def runs_function(
    head: str, session: SessionState, registry: MountRegistry
) -> bool:
    """Whether a function of the head's name runs instead of it, so the
    words it was given run nothing: the function's own lines each pass
    the gate as they run (``timeout() { :; }; timeout 1 rm x``).

    Args:
        head (str): the command name, as the gate reads it.
        session (SessionState): the session (its functions).
        registry (MountRegistry): mount registry (command registration).
    """
    return (
        head in session.functions
        and lookup(head, session, registry) is Consumer.FUNCTION
    )
