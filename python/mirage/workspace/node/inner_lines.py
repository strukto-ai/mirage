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
from dataclasses import dataclass

from mirage.commands.spec.shell import SHELL_SPECS, parse_shell_options
from mirage.shell.helpers import get_text, literal_word
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.utils.fnmatch import pattern_shape
from mirage.utils.glob_walk import has_glob, mark_escaped_globs
from mirage.workspace.executor.builtins.script.bash import parse_bash_args
from mirage.workspace.executor.builtins.timeout.timeout import timeout_missing
from mirage.workspace.executor.builtins.xargs.xargs import xargs_missing


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


def read_word(node: TSNodeLike, home: str | None = None) -> Word:
    """Read a word without losing which glob characters are quoted.

    Args:
        node (TSNodeLike): the command word's syntax node.
        home (str | None): the home directory a leading tilde names.
    """
    return Word(get_text(node), literal_word(node, home), _word_globs(node))


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
        missing (str | None): what the command writes when the session
            cannot see the name it runs: ``xargs`` and ``timeout`` look
            the name up themselves and report it in GNU's words. None
            where the shell reports it (``command not found``).
    """

    line: str | None = None
    argv: tuple[Word, ...] = ()
    open: bool = False
    missing: str | None = None

    @property
    def readable(self) -> bool:
        """Whether the gate can read what runs."""
        return self.line is not None or bool(self.argv)


_FIND_EXEC = frozenset({"-exec", "-execdir", "-ok", "-okdir"})
_ENV_FLAGS = frozenset({"-i", "--ignore-environment", "-0", "--null", "-"})


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
    """``exec [-cl] [-a name] [command [arg ...]]``."""
    i = 0
    while i < len(args) and args[i].value.startswith("-"):
        word = args[i].value
        i += 1
        if word == "--":
            break
        if word.endswith("a"):
            i += 1
    rest = tuple(args[i:])
    return [InnerLine(argv=rest)] if rest else []


def _env_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``env [-i] [-u NAME]... [NAME=VALUE]... [command [arg]...]``,
    read the way the tree's ``env`` builtin reads it."""
    i = 0
    while i < len(args):
        word = args[i].value
        if word == "--":
            i += 1
            break
        if word in _ENV_FLAGS or word.startswith("--unset="):
            i += 1
            continue
        if word in ("-u", "--unset"):
            i += 2
            continue
        if word.startswith("-") and len(word) > 1:
            # A cluster ending in `u` takes the next word as the name.
            i += 2 if word.endswith("u") else 1
            continue
        break
    while (
        i < len(args)
        and "=" in args[i].value
        and not args[i].value.startswith("=")
    ):
        i += 1
    rest = tuple(args[i:])
    return [InnerLine(argv=rest)] if rest else []


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
    return [
        InnerLine(
            argv=operands[1:], missing=timeout_missing(operands[1].value)
        )
    ]


def _xargs_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``xargs [OPTION]... [COMMAND [INITIAL-ARGS]]``, ``echo`` when
    none, items from stdin appended."""
    operands = _spec_operands("xargs", args)
    if operands is None:
        return []
    argv = operands or (Word("echo", "echo"),)
    return [
        InnerLine(argv=argv, open=True, missing=xargs_missing(argv[0].value))
    ]


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


def _nice_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``nice [-n N] COMMAND [ARG]...``."""
    i = 0
    while i < len(args) and args[i].value.startswith("-"):
        word = args[i].value
        i += 1
        if word == "--":
            break
        if word in ("-n", "--adjustment"):
            i += 1
    rest = tuple(args[i:])
    return [InnerLine(argv=rest)] if rest else []


def _time_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``time [-p] COMMAND [ARG]...``."""
    i = 0
    while i < len(args) and args[i].value in ("-p", "--"):
        i += 1
    rest = tuple(args[i:])
    return [InnerLine(argv=rest)] if rest else []


def _nohup_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``nohup COMMAND [ARG]...``."""
    rest = tuple(args[1:] if args and args[0].value == "--" else args)
    return [InnerLine(argv=rest)] if rest else []


def _builtin_inner(args: Sequence[Word]) -> list[InnerLine]:
    """``builtin shell-builtin [ARG]...``: the named builtin runs with
    the words as given (bash takes no options here but still honors a
    leading ``--``), so ``builtin eval 'rm x'`` is ``eval``'s line."""
    rest = tuple(args[1:] if args and args[0].value == "--" else args)
    return [InnerLine(argv=rest)] if rest else []


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
    parsed = parse_bash_args(literal)
    if parsed.help or parsed.version:
        return []
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
    runtime's own world: the allow list is the closed form there.

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
        return _builtin_inner(args)
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
    if head == "nice":
        return _nice_inner(args)
    if head == "time":
        return _time_inner(args)
    if head == "nohup":
        return _nohup_inner(args)
    return []
