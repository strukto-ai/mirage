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

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Literal, TypeAlias

from mirage.commands.spec.constants import flag_kwarg_name
from mirage.types import PathSpec


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
# PathSpec on the way through (``mount.execute_cmd``), which is the one
# member the TypeScript twin does not carry -- its bag keeps resolved
# virtual-path strings instead. A command takes the bag as
# ``**flags: FlagValue`` and reads it through FlagView, never by
# unpacking these members. The mixed list is the ``pair`` shape: a pair
# option accumulates (name, value) flattened, so a PATH-typed pair like
# jq's ``--rawfile name file`` alternates text and PathSpec.
FlagValue: TypeAlias = (ParsedFlagValue | PathSpec | list[PathSpec]
                        | list[str | PathSpec])


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
    description: str | None = None


@dataclass(frozen=True)
class Operand:
    """One positional argument slot.

    Args:
        type (ValueType): "path" operands are cwd-resolved and routed for
            mount dispatch; textual operands pass through verbatim
            (never "bool": an operand is a value by definition).
        text_when (tuple[str, ...]): flags that make this slot textual
            even though it is declared "path". jq's ``--args`` turns the
            operands after the program into positional string values
            rather than input files, which is a property of the line, not
            of the slot, so it cannot be spelled in the type alone.
        provided_by (tuple[str, ...]): flags that supply this operand's
            value. When any is present the slot is skipped and remaining
            args classify as rest (e.g. grep's pattern with -e/-f). This is
            the declarative form of the conditional real tools write by hand
            (grep's ``if (!pattern_given)`` getopt loop); the same scenario
            clap names ``required_unless_present`` and docopt expresses as
            alternate usage patterns. It lives in the spec, not in command
            code, because Mirage classifies args before a backend is chosen.
    """
    type: ValueType = "path"
    provided_by: tuple[str, ...] = ()
    text_when: tuple[str, ...] = ()


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


class FlagView:
    """Typed read-only view over raw flag kwargs.

    Commands receive flags as an untyped mapping from the dispatcher; this
    view is the one sanctioned way to read them, replacing ad-hoc
    `flags.get(...) is True` and isinstance chains.

    Args:
        flags (Mapping[str, FlagValue] | None): raw flag kwargs.
        spec (CommandSpec | None): when given, reads of names the spec does
            not declare raise KeyError. A missing key is otherwise
            indistinguishable from "flag not passed", so a typo in the name
            would silently read as False/None.
    """

    def __init__(self,
                 flags: Mapping[str, FlagValue] | None,
                 spec: CommandSpec | None = None) -> None:
        self._flags = flags if flags is not None else {}
        self._allowed = spec_flag_names(spec) if spec is not None else None

    def _key(self, name: str) -> str:
        if self._allowed is not None and name not in self._allowed:
            raise KeyError(f"flag {name!r} is not declared by the command "
                           f"spec (known: {sorted(self._allowed)})")
        return name

    def as_bool(self, name: str) -> bool:
        value = self._flags.get(self._key(name))
        if isinstance(value, bool):
            return value
        # A count flag holds an int; any occurrence reads as set.
        return isinstance(value, int) and value > 0

    def as_int(self, name: str) -> int | None:
        value = self._flags.get(self._key(name))
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        if not isinstance(value, str):
            return None
        try:
            return int(value)
        except ValueError as exc:
            raise ValueError(f"flag '{name}' expects an integer, "
                             f"got '{value}'") from exc

    def as_float(self, name: str) -> float | None:
        value = self._flags.get(self._key(name))
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            return float(value)
        if not isinstance(value, str):
            return None
        try:
            return float(value)
        except ValueError as exc:
            raise ValueError(f"flag '{name}' expects a number, "
                             f"got '{value}'") from exc

    def as_str(self, name: str) -> str | None:
        value = self._flags.get(self._key(name))
        return value if isinstance(value, str) else None

    def as_list(self, name: str) -> list[str]:
        value = self._flags.get(self._key(name))
        if isinstance(value, list):
            return [item for item in value if isinstance(item, str)]
        if isinstance(value, str):
            return [value]
        return []

    def as_paths(self, name: str) -> list[PathSpec]:
        # PATH-typed flag values arrive as PathSpec in the python
        # executor; the TypeScript flag bag carries their resolved
        # virtual-path strings, so its counterpart is asList.
        value = self._flags.get(self._key(name))
        if isinstance(value, list):
            return [item for item in value if isinstance(item, PathSpec)]
        if isinstance(value, PathSpec):
            return [value]
        return []

    def raw(self, name: str) -> FlagValue | None:
        return self._flags.get(self._key(name))


def spec_flag_names(spec: CommandSpec) -> frozenset[str]:
    """Collect the kwarg names a spec's options can produce.

    One name per option: the long spelling when an option declares
    both, matching the parser's canonical dest. Keeping the short
    spelling here too would let a stale ``fl.as_bool("a")`` stay legal
    and read False forever after dest unification; canonical-only
    turns that silent miss into a KeyError.

    Args:
        spec (CommandSpec): command spec whose options to enumerate.
    """
    names: set[str] = set()
    for option in spec.options:
        canonical = option.long if option.long is not None else option.short
        if canonical is not None:
            names.add(flag_kwarg_name(canonical))
    return frozenset(names)


@dataclass
class ParsedArgs:
    flags: dict[str, ParsedFlagValue]
    args: list[tuple[str, ValueType]]
    cache_paths: list[str] = field(default_factory=list)
    path_flag_values: list[str] = field(default_factory=list)
    raw_operands: list[tuple[str, ValueType]] = field(default_factory=list)
    text_flag_values: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    word_kinds: list[ValueType | None] = field(default_factory=list)
    # Per-position base directory, aligned with word_kinds: the absolute
    # path a word resolves against when an operand_base option (tar's -C)
    # moved it, and None when the session cwd still applies. Only a spec
    # declaring operand_base ever fills this.
    word_bases: list[str | None] = field(default_factory=list)
    # GNU-shaped option errors, reported (never raised) by the parser:
    # undeclared options ('--bogus' or the offending cluster char 'Y'),
    # abbreviated longs matching several options (typed prefix, matched
    # spellings in declaration order), declared value flags that ran out
    # of line ('--max-depth', 'm'), values outside a declared choices set
    # (canonical spelling, value, allowed values), non-integer values on
    # int-typed options (canonical spelling, value), and absent required
    # options (canonical spelling).
    invalid_options: list[str] = field(default_factory=list)
    ambiguous_options: list[tuple[str,
                                  tuple[str,
                                        ...]]] = field(default_factory=list)
    # "invalid" / "ambiguous" tags in scan encounter order, so the refusal
    # names the FIRST offending token like GNU (grep --c --bogus reports
    # --c; reversed reports --bogus). needs_value is absent by
    # construction: it only fires on the line's final token, so it can
    # never precede another scan error.
    option_error_kinds: list[str] = field(default_factory=list)
    needs_value_options: list[str] = field(default_factory=list)
    invalid_value_options: list[tuple[str, str, tuple[str, ...]]] = field(
        default_factory=list)
    invalid_int_options: list[tuple[str, str]] = field(default_factory=list)
    invalid_float_options: list[tuple[str, str]] = field(default_factory=list)
    missing_required_options: list[str] = field(default_factory=list)
    # The old-style cluster letter whose argument ran off the end of the
    # line (`tar xzf` with no archive). Its own report because GNU tar
    # words it differently and exits differently from every getopt
    # refusal above, and because it outranks all of them: tar counts the
    # cluster's argument needs before argp ever validates a letter, so
    # `tar Qf` and `tar fQ` both name f, not Q.
    old_option_needs_value: str | None = None

    def paths(self) -> list[str]:
        return [v for v, k in self.args if k == "path"]

    def routing_paths(self) -> list[str]:
        return self.paths() + self.path_flag_values

    def texts(self) -> list[str]:
        return [v for v, k in self.args if k != "path"]

    def flag(self, name: str, default: Any = None) -> Any:
        return self.flags.get(name, default)
