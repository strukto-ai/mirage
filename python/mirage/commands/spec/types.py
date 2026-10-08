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

from dataclasses import dataclass
from enum import Enum, StrEnum
from typing import Literal, TypeAlias

from mirage.types import PathSpec


class UsageStyle(Enum):
    """Which program's voice a CLI answers usage questions in.

    An installed CLI is not a GNU tool, so a leaf that refuses an option
    it does not declare answers in argparse's shape and exit code by
    default. A CLI that mimics an existing program has to answer in that
    program's shape instead: mirage implements a subset of git, so most
    of git's real options arrive undeclared, and an agent that reads the
    refusal should see what git would have said rather than learn that
    it is talking to a reimplementation.

    GIT covers the unknown-option refusal and the exit code, which is
    what an undeclared flag produces; every other usage error (a missing
    value, an unparseable int) stays in argparse's shape, because those
    only happen for options a CLI does declare.

    CLAP additionally governs how help is laid out and how a missing
    operand is refused, because a clap program prints a bare description
    line, spells the option placeholder ``[OPTIONS]``, heads the option
    list ``Options:``, lists subcommands in declaration order, and names
    the empty slots rather than leaving each leaf to word its own
    complaint. Those are one decision (whose voice this is), so they
    read off this knob rather than a second one.

    It lives in the spec layer, not beside the CLI tree, because the
    help renderer is the spec's and cannot import upward to reach it.
    """

    ARGPARSE = "argparse"
    GIT = "git"
    CLAP = "clap"


class CommandName(StrEnum):
    """Command names the spec layer references by value.

    Not a registry of every command: only names that appear away from
    their own module (usage message shapes, arity guards). StrEnum
    members compare and hash as their plain string values, so the raw
    ``str`` the executor passes still matches. Mirrors the crossmount
    ``Cmd`` pattern.
    """

    BASE64 = "base64"
    CMP = "cmp"
    COMM = "comm"
    CSPLIT = "csplit"
    DATE = "date"
    DIFF = "diff"
    FIND = "find"
    JOIN = "join"
    LOOK = "look"
    MKTEMP = "mktemp"
    PATCH = "patch"
    SEQ = "seq"
    SPLIT = "split"
    TR = "tr"
    TSORT = "tsort"
    UNAME = "uname"
    UNIQ = "uniq"
    XXD = "xxd"


# The one type axis for option and operand values (argparse type= as
# data, extended with the two members mirage's own parsing needs: "bool"
# consumes no token, "path" enters the resolve/route/PathSpec pipeline).
# "str" is inert; "int"/"float" are validated post-scan. Rule for every
# consumer: never enumerate the textual family; test == "path" or
# == "bool" (or their negations) only, so new validator types never
# touch classification sites.
ValueType = Literal["bool", "str", "int", "float", "path"]

# What the parser itself can put in the bag: it works on argv, so every
# value is still text, or the bool/int a flag's own shape implies.
ParsedFlagValue: TypeAlias = str | bool | int | list[str]
# What a command receives. The executor rewrites PATH-typed values into
# PathSpec on the way through (``mount.run_command``), the PathSpec of
# the word that spelled it, so an error line can name the path as typed.
# Mirrors the TypeScript FlagValue. A command takes the bag as
# ``**flags: FlagValue`` and reads it through FlagView, never by
# unpacking these members. The mixed list is the ``pair`` shape: a pair
# option accumulates (name, value) flattened, so a PATH-typed pair like
# jq's ``--rawfile name file`` alternates text and PathSpec.
FlagValue: TypeAlias = (
    ParsedFlagValue | PathSpec | list[PathSpec] | list[str | PathSpec]
)


@dataclass(frozen=True)
class Option:
    """One flag accepted by a command.

    Args:
        short (str | None): short form, e.g. "-e".
        long (str | None): long form, e.g. "--max-depth".
        type (ValueType): the flag's one type axis. "bool" (the default)
            consumes no token and clusters; "path" values are
            cwd-resolved and routed for mount dispatch, and reach the
            command as PathSpec; "str" values pass through untouched;
            "int"/"float" values are refused at parse time when they are
            not numbers (argparse's ``invalid int value``; the walk uses
            git's ``expects a numerical value``). The accepted numeric
            shapes are the portable core shared by both languages (sign
            plus digits; no underscores, inf, or nan). The bag holds the
            string either way: commands read it through
            ``FlagView.as_int`` / ``as_float``, and
            builtins whose GNU tool words its own numeric refusal
            (``head: invalid number of lines``) keep ``"str"``.
        numeric_shorthand (bool): treat "-<digits>" as this flag's value
            (e.g. head -5).
        count (bool): boolean flag whose occurrences accumulate into an
            int (click count semantics): ``-vvv`` and ``-v -v -v`` both
            parse as 3. Only meaningful with type "bool".
        multiple (bool): repeated occurrences accumulate into a list
            instead of last-wins (argparse append / click multiple, e.g.
            grep -e). Textual values arrive as list[str]; "path" values
            are each resolved and routed and arrive as list[PathSpec].
        pair (bool): the option consumes two tokens, not one (jq's
            ``--arg name value``; click's ``nargs=2``). Occurrences always
            accumulate, flattened, so ``--arg a 1 --arg b 2`` arrives as
            ``["a", "1", "b", "2"]`` and the command reads it in twos.
            The first token of each pair names the value and is always
            textual; ``type`` describes the second, so a "path" pair
            (``--rawfile name file``) resolves and routes only the file.
            An ``=`` form is not accepted (neither does jq), and a
            trailing occurrence missing either token is the usual
            "requires an argument" refusal.
        value_optional (bool): GNU optional-argument long option (e.g.
            ``--color[=WHEN]``): bare ``--color`` parses as True,
            ``--color=auto`` parses as the string, and a detached next
            token is never consumed. Requires a long form.
        short_value (bool): whether the short spelling of a value flag may
            carry an attached value (``split -d10``). False for GNU pairs
            whose short is a plain boolean while only the long accepts a
            value (``cp -b`` vs ``--backup[=CONTROL]``), so the short
            clusters (``-bv``) instead of eating the rest as a value.
        choices (tuple[str, ...]): allowed values for a value flag. Any
            other value is reported (never raised) by the parser and
            surfaces as GNU's ARGMATCH refusal (``tee: invalid argument
            'x' for '--output-error'`` plus the valid list). The bare
            boolean form of an optional-value flag is exempt.
        required (bool): the option must appear on the line; a line
            without it (and without a default) is a usage error. Click
            spelling; GNU tools express this per-command by hand.
        default (str | None): value recorded when the flag is absent, as
            if it had been typed (a "path" default resolves and routes, a
            defaulted value must satisfy choices). Presence of a default
            always satisfies ``required``.
        metavar (str | None): the value's name in a usage line, bare
            (``VERSION``, rendered ``--notion-version <VERSION>``); the
            brackets belong to the renderer, which is the only thing
            that knows the dialect. Only a program whose usage lines are
            rendered in someone else's needs one, since otherwise the
            name is derived from the long spelling.
        env (str | None): environment variable that supplies this option
            when the line omits it. Distinct from ``default``, and not a
            synonym for it: an env-sourced value counts as *supplied*
            (clap echoes it in a usage line, where a defaulted one is
            invisible), and it is read from the session rather than
            frozen into the spec. Declaring it here is what keeps one
            fact in one place, since both the leaf that sends the value
            and the renderer that reports the line need it.
        description (str | None): help text.
    """

    short: str | None = None
    long: str | None = None
    type: ValueType = "bool"
    numeric_shorthand: bool = False
    count: bool = False
    multiple: bool = False
    pair: bool = False
    value_optional: bool = False
    short_value: bool = True
    choices: tuple[str, ...] = ()
    required: bool = False
    default: str | None = None
    metavar: str | None = None
    env: str | None = None
    description: str | None = None


@dataclass(frozen=True)
class Operand:
    """One positional argument slot.

    Args:
        type (ValueType): "path" operands are cwd-resolved and routed for
            mount dispatch; textual operands pass through verbatim
            (never "bool": an operand is a value by definition).
        text_when (tuple[str, ...]): flags that make this slot textual
            even though it is declared "path". tar's ``-x`` turns the
            operands into member names rather than files, and jq's
            ``--args`` turns them into positional string values, which is
            a property of the line, not of the slot, so it cannot be
            spelled in the type alone. The flag reaches every operand on
            the line, or only the ones typed after it for a program that
            files each operand as it reads it (IN_ORDER_OPERANDS, jq).
        provided_by (tuple[str, ...]): flags that supply this operand's
            value. When any is present the slot is skipped and remaining
            args classify as rest (e.g. grep's pattern with -e/-f). This is
            the declarative form of the conditional real tools write by hand
            (grep's ``if (!pattern_given)`` getopt loop); the same scenario
            clap names ``required_unless_present`` and docopt expresses as
            alternate usage patterns. It lives in the spec, not in command
            code, because Mirage classifies args before a backend is chosen.
        name (str): the slot's name in a usage line, bare (``PAGE_ID``,
            rendered ``<PAGE_ID>`` when required and ``[PAGE_ID]`` when
            not); the brackets belong to the renderer, which is the only
            thing that knows the dialect. Empty renders the generic
            ``<path>``/``<text>`` placeholder the ordinary help uses.
        required (bool): the line must supply this slot; one that does
            not is a usage error the parser reports, rather than
            something each leaf re-discovers and words its own way.
        remainder (bool): every word from this slot on is gathered
            verbatim, options included. This is argparse's
            ``nargs=argparse.REMAINDER`` and POSIX's own option order:
            the first operand ends option parsing, where GNU's default
            permutes instead (``ls a -1`` reads ``-1`` as a flag,
            ``POSIXLY_CORRECT=1 ls a -1`` reads it as a filename). Set
            it for a command that dispatches to another program, which
            is the case argparse documents it for: python3's script and
            the words after it are the script's argv, so
            ``python3 s.py --foo`` must hand ``--foo`` over untouched
            while ``python3 -zz s.py`` must still refuse ``-zz`` as
            python3's own. One switch cannot do both, which is why the
            boundary has to be declared.
    """

    type: ValueType = "path"
    provided_by: tuple[str, ...] = ()
    text_when: tuple[str, ...] = ()
    name: str = ""
    required: bool = False
    remainder: bool = False


@dataclass(frozen=True)
class CommandSpec:
    options: tuple[Option, ...] = ()
    positional: tuple[Operand, ...] = ()
    rest: Operand | None = None
    ignore_tokens: frozenset[str] = frozenset()
    description: str | None = None
    epilog: str | None = None
    # tar's old option style: a first word with no leading dash is a
    # cluster of option letters whose arguments follow as separate words
    # (`tar xzf a.tgz`). Expanded by expand_old_style before any other
    # scanning; see oldstyle.py for the rules and why only tar has it.
    old_option_style: bool = False
    # The spelling of an option that changes directory for the path
    # operands typed AFTER it (tar's -C). Positional and cumulative, the
    # way a real chdir is: `tar -cf a.tar -C d1 x -C ../d2 y` reads d1/x
    # and d1/../d2/y. Only path operands and the option's own value move;
    # every other path-valued flag keeps resolving against the session
    # cwd, which is what GNU does with -f.
    operand_base: str | None = None
    # argparse's `allow_abbrev`: whether an unambiguous prefix of a long
    # option stands for it. getopt_long and argparse both expand one by
    # default; clap and lexopt (ripgrep) do not, so a program parsed with
    # either declares False and `--pcr` is refused rather than read as
    # `--pcre2-unicode`.
    allow_abbrev: bool = True
