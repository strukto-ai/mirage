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
from enum import Enum, StrEnum
from typing import Any, Literal

from mirage.commands.spec.constants import flag_kwarg_name


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


class OperandKind(str, Enum):
    NONE = "none"
    PATH = "path"
    TEXT = "text"


@dataclass(frozen=True)
class Option:
    """One flag accepted by a command.

    Args:
        short (str | None): short form, e.g. "-e".
        long (str | None): long form, e.g. "--max-depth".
        value_kind (OperandKind): NONE for boolean flags; TEXT or PATH for
            value flags. PATH values are cwd-resolved and routed for mount
            dispatch, and reach the command as PathSpec.
        numeric_shorthand (bool): treat "-<digits>" as this flag's value
            (e.g. head -5).
        count (bool): boolean flag whose occurrences accumulate into an
            int (click count semantics): ``-vvv`` and ``-v -v -v`` both
            parse as 3. Only meaningful with value_kind NONE.
        multiple (bool): repeated occurrences accumulate into a list
            instead of last-wins (argparse append / click multiple, e.g.
            grep -e). TEXT values arrive as list[str]; PATH values are
            each resolved and routed and arrive as list[PathSpec].
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
            if it had been typed (a PATH default resolves and routes, a
            defaulted value must satisfy choices). Presence of a default
            always satisfies ``required``.
        type (Literal["str", "int"]): argparse ``type=`` as data. "int"
            makes the parser refuse a non-integer value at parse time
            (argparse's ``invalid int value``; the walk uses git's
            ``expects a numerical value``), before the command runs. The
            accepted shape is an optional sign plus digits, the portable
            core of Python ``int()`` and argparse. The bag still holds
            the string: commands read it through ``FlagView.as_int``,
            the established mirage convention. Builtins whose GNU tool
            words its own numeric refusal (``head: invalid number of
            lines``) keep ``"str"`` and validate in the command.
        description (str | None): help text.
    """
    short: str | None = None
    long: str | None = None
    value_kind: OperandKind = OperandKind.NONE
    numeric_shorthand: bool = False
    count: bool = False
    multiple: bool = False
    value_optional: bool = False
    short_value: bool = True
    choices: tuple[str, ...] = ()
    required: bool = False
    default: str | None = None
    type: Literal["str", "int"] = "str"
    description: str | None = None


@dataclass(frozen=True)
class Operand:
    """One positional argument slot.

    Args:
        kind (OperandKind): PATH operands are cwd-resolved and routed for
            mount dispatch; TEXT operands pass through verbatim.
        provided_by (tuple[str, ...]): flags that supply this operand's
            value. When any is present the slot is skipped and remaining
            args classify as rest (e.g. grep's pattern with -e/-f). This is
            the declarative form of the conditional real tools write by hand
            (grep's ``if (!pattern_given)`` getopt loop); the same scenario
            clap names ``required_unless_present`` and docopt expresses as
            alternate usage patterns. It lives in the spec, not in command
            code, because Mirage classifies args before a backend is chosen.
    """
    kind: OperandKind = OperandKind.PATH
    provided_by: tuple[str, ...] = ()


@dataclass(frozen=True)
class CommandSpec:
    options: tuple[Option, ...] = ()
    positional: tuple[Operand, ...] = ()
    rest: Operand | None = None
    ignore_tokens: frozenset[str] = frozenset()
    description: str | None = None
    epilog: str | None = None


class FlagView:
    """Typed read-only view over raw flag kwargs.

    Commands receive flags as an untyped mapping from the dispatcher; this
    view is the one sanctioned way to read them, replacing ad-hoc
    `flags.get(...) is True` and isinstance chains.

    Args:
        flags (Mapping[str, object] | None): raw flag kwargs.
        spec (CommandSpec | None): when given, reads of names the spec does
            not declare raise KeyError. A missing key is otherwise
            indistinguishable from "flag not passed", so a typo in the name
            would silently read as False/None.
    """

    def __init__(self,
                 flags: Mapping[str, object] | None,
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
        return int(value) if isinstance(value, str) else None

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

    def raw(self, name: str) -> object:
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
    flags: dict[str, str | bool | int | list[str]]
    args: list[tuple[str, OperandKind]]
    cache_paths: list[str] = field(default_factory=list)
    path_flag_values: list[str] = field(default_factory=list)
    raw_operands: list[tuple[str, OperandKind]] = field(default_factory=list)
    text_flag_values: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    word_kinds: list[OperandKind | None] = field(default_factory=list)
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
    needs_value_options: list[str] = field(default_factory=list)
    invalid_value_options: list[tuple[str, str, tuple[str, ...]]] = field(
        default_factory=list)
    invalid_int_options: list[tuple[str, str]] = field(default_factory=list)
    missing_required_options: list[str] = field(default_factory=list)

    def paths(self) -> list[str]:
        return [v for v, k in self.args if k == OperandKind.PATH]

    def routing_paths(self) -> list[str]:
        return self.paths() + self.path_flag_values

    def texts(self) -> list[str]:
        return [v for v, k in self.args if k == OperandKind.TEXT]

    def flag(self, name: str, default: Any = None) -> Any:
        return self.flags.get(name, default)
