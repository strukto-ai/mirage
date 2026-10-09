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

    COBRA keeps standard help and option errors, while handlers own
    missing positional refusals for programs such as gh. It does not
    reproduce Cobra's full help formatting.

    It lives in the spec layer, not beside the CLI tree, because the
    help renderer is the spec's and cannot import upward to reach it.
    """

    ARGPARSE = "argparse"
    GIT = "git"
    CLAP = "clap"
    COBRA = "cobra"


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


# Argument value types plus the scanner's internal zero-token shape, "bool".
# Public boolean flags declare action="store_true" or action="count".
# Numeric values are validated; path values enter virtual path resolution.
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


@dataclass(frozen=True, init=False)
class Argument:
    """One named option or positional slot, using argparse's vocabulary.

    Dashed names declare an option; one bare name declares a positional.
    ``action`` controls storage and ``nargs`` controls token consumption.
    ``path`` values enter Mirage's virtual path resolution pipeline.
    ``attached_only`` preserves GNU optional values, and ``value_types``
    describes named value pairs such as jq's name/value and name/file.
    """

    names: tuple[str, ...]
    type: ValueType = "str"
    action: Literal["store", "store_true", "count", "append", "extend"] = (
        "store"
    )
    nargs: int | Literal["?", "*", "+", "REMAINDER"] | None = None
    choices: tuple[str, ...] = ()
    required: bool = False
    default: str | None = None
    metavar: str | None = None
    env: str | None = None
    help: str | None = None
    numeric_shorthand: bool = False
    short_value: bool = True
    attached_only: bool = False
    provided_by: tuple[str, ...] = ()
    text_when: tuple[str, ...] = ()
    value_types: tuple[ValueType, ...] = ()

    def __init__(
        self,
        *names: str,
        type: ValueType = "str",
        action: Literal[
            "store", "store_true", "count", "append", "extend"
        ] = "store",
        nargs: int | Literal["?", "*", "+", "REMAINDER"] | None = None,
        choices: tuple[str, ...] = (),
        required: bool = False,
        default: str | None = None,
        metavar: str | None = None,
        env: str | None = None,
        help: str | None = None,
        numeric_shorthand: bool = False,
        short_value: bool = True,
        attached_only: bool = False,
        provided_by: tuple[str, ...] = (),
        text_when: tuple[str, ...] = (),
        value_types: tuple[ValueType, ...] = (),
    ) -> None:
        values = locals()
        for name in self.__dataclass_fields__:
            object.__setattr__(self, name, values[name])


@dataclass(frozen=True)
class CommandSpec:
    arguments: tuple[Argument, ...] = ()
    name: str = ""
    aliases: tuple[str, ...] = ()
    subcommands: tuple["CommandSpec", ...] = ()
    usage_style: UsageStyle = UsageStyle.ARGPARSE
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
    add_help: bool = True
