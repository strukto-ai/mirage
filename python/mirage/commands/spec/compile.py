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
from dataclasses import dataclass, field
from functools import lru_cache

from mirage.commands.spec.constants import FLOAT_VALUE, INT_VALUE
from mirage.commands.spec.types import Argument, CommandSpec, ValueType


def option_spellings(argument: Argument) -> tuple[str | None, str | None]:
    """First short and long spelling, for dialects that display each separately."""
    return (
        next(
            (name for name in argument.names if not name.startswith("--")),
            None,
        ),
        next((name for name in argument.names if name.startswith("--")), None),
    )


def argument_dest(argument: Argument) -> str:
    """Canonical option spelling, or the positional argument's name."""
    return next(
        (name for name in argument.names if name.startswith("--")),
        argument.names[0],
    )


def positional_name(argument: Argument) -> str:
    """Declared positional placeholder, including an explicit empty placeholder."""
    return (
        argument.metavar if argument.metavar is not None else argument.names[0]
    )


def positional_required(argument: Argument) -> bool:
    return argument.nargs not in ("?", "*", "REMAINDER")


def argument_shapes(
    spec: CommandSpec,
) -> tuple[tuple[Argument, ...], tuple[Argument, ...], Argument | None]:
    """Lower the public argument declarations into scanning slots."""
    options: list[Argument] = []
    positional: list[Argument] = []
    rest: Argument | None = None
    seen_names: set[str] = set()
    for argument in spec.arguments:
        if not argument.names or any(
            not name or name in ("-", "--") for name in argument.names
        ):
            raise ValueError("argument requires a name or option spelling")
        option = argument.names[0].startswith("-")
        if any(name.startswith("-") != option for name in argument.names):
            raise ValueError(
                "argument cannot mix positional names and option spellings"
            )
        if argument.type == "bool":
            raise ValueError(
                "argument type 'bool' is expressed with action='store_true'"
            )
        if argument.action not in (
            "store",
            "store_true",
            "count",
            "append",
            "extend",
        ):
            raise ValueError(f"invalid argument action {argument.action!r}")
        if argument.nargs not in (None, "?", "*", "+", "REMAINDER") and not (
            isinstance(argument.nargs, int) and argument.nargs > 0
        ):
            raise ValueError(f"invalid nargs {argument.nargs!r}")
        if argument.value_types and (
            not isinstance(argument.nargs, int)
            or len(argument.value_types) != argument.nargs
        ):
            raise ValueError(
                "value_types must match the argument's fixed nargs"
            )
        if option:
            if argument.provided_by or argument.text_when:
                raise ValueError(
                    "provided_by and text_when belong to positional arguments"
                )
            if argument.action in ("store_true", "count") and (
                argument.nargs is not None or argument.type != "str"
            ):
                raise ValueError("zero-token actions cannot declare nargs")
            if argument.nargs in ("*", "+", "REMAINDER"):
                raise ValueError(
                    "variadic nargs belongs to positional arguments"
                )
            if isinstance(argument.nargs, int) and argument.action == "append":
                raise ValueError(
                    "multi-value options use action='extend' or 'store'"
                )
            if argument.value_types and argument.value_types not in (
                ("str", "str"),
                ("str", "path"),
            ):
                raise ValueError("value_types supports named text/path pairs")
            if argument.value_types and argument.nargs != 2:
                raise ValueError("value_types requires nargs=2")
            if argument.attached_only and argument.nargs != "?":
                raise ValueError("attached_only requires nargs='?'")
            options.append(argument)
        else:
            if len(argument.names) != 1:
                raise ValueError(
                    "a positional argument takes exactly one name"
                )
            name = argument.names[0]
            if name in seen_names:
                raise ValueError(f"duplicate positional argument {name!r}")
            seen_names.add(name)
            if argument.default is not None:
                raise ValueError("positional defaults are not supported")
            if argument.value_types:
                raise ValueError("value_types belongs to fixed option values")
            if argument.required:
                raise ValueError(
                    "positional requiredness is expressed with nargs"
                )
            if argument.action != "store":
                raise ValueError("positional arguments use action='store'")
            if (
                argument.env
                or argument.numeric_shorthand
                or argument.attached_only
                or not argument.short_value
            ):
                raise ValueError(
                    "option settings cannot be used on positional arguments"
                )
            if argument.nargs in ("*", "+", "REMAINDER"):
                if rest is not None:
                    raise ValueError(
                        "only one variadic positional argument is supported"
                    )
                rest = argument
            else:
                if rest is not None:
                    raise ValueError(
                        "a variadic positional argument must be last"
                    )
                positional.extend(
                    [argument]
                    * (
                        argument.nargs
                        if isinstance(argument.nargs, int)
                        else 1
                    )
                )
    return tuple(options), tuple(positional), rest


@dataclass(frozen=True, slots=True)
class CompiledSpec:
    """A CommandSpec lowered into the lookup tables the parser walks.

    Built once per spec (cached) instead of rebuilt on every
    parse_command call. Spellings are the dashed forms as typed
    (``-e``, ``--regexp``); ``dest`` maps every spelling to its
    canonical spelling, the long form when an option declares both, so
    the parsed flag bag holds ONE entry per option regardless of which
    spelling appeared on the line (click/argparse dest semantics).

    Args:
        bool_spellings (frozenset[str]): short spellings parsed as bare
            booleans (true booleans plus optional-value shorts).
        value_spellings (tuple[str, ...]): short spellings expecting a
            value, longest first so ``-name`` can never lose an
            attached match to ``-n``.
        attach_spellings (tuple[str, ...]): short spellings whose value
            may attach to the same token (``split -d10``), longest
            first.
        long_bool_spellings (frozenset[str]): long spellings parsed as
            bare booleans (true booleans plus optional-value longs).
        long_value_spellings (frozenset[str]): long spellings that
            require a value.
        long_optional_spellings (frozenset[str]): long spellings whose
            value only attaches via ``=`` (GNU optional argument).
        kind_of (dict[str, ValueType]): value kind per spelling.
        kind_by_dest (dict[str, ValueType]): value kind per canonical
            spelling, for post-parse PATH/TEXT value collection.
        dest (dict[str, str]): spelling -> canonical spelling.
        multiple_dests (frozenset[str]): canonical spellings that
            accumulate repeated values into a list.
        count_dests (frozenset[str]): canonical spellings of boolean
            flags whose occurrences accumulate into an int (click count,
            ``-vvv``).
        long_spellings (tuple[str, ...]): every long spelling in
            declaration order (the order GNU's ambiguity refusal lists
            possibilities), for getopt_long prefix expansion.
        int_dests (frozenset[str]): canonical spellings of int-typed
            options; the parser refuses a non-integer value at parse
            time (argparse ``type=int``).
        float_dests (frozenset[str]): canonical spellings of float-typed
            options, refused the same way (argparse ``type=float``).
        choices_by_dest (dict[str, tuple[str, ...]]): allowed values per
            canonical spelling, in declaration order (the order GNU's
            ARGMATCH refusal lists them).
        required_dests (tuple[str, ...]): canonical spellings that must
            appear, in declaration order; a default satisfies the
            requirement.
        defaults (dict[str, str]): value recorded per canonical spelling
            when the flag is absent from the line.
        numeric_dest (str | None): canonical spelling fed by the
            ``-<digits>`` shorthand, when one option declares it.
        rest_kind (ValueType | None): kind of the rest operand.
        remainder (bool): the rest operand gathers every word from the
            first operand on, options included (``Argument.nargs``,
            argparse's ``nargs=REMAINDER``).
        base_dest (str | None): canonical spelling of the option that
            re-bases the path operands after it (``CommandSpec.
            operand_base``, tar's -C).
    """

    options: tuple[Argument, ...] = ()
    positional: tuple[Argument, ...] = ()
    rest: Argument | None = None
    bool_spellings: frozenset[str] = frozenset()
    value_spellings: tuple[str, ...] = ()
    attach_spellings: tuple[str, ...] = ()
    long_bool_spellings: frozenset[str] = frozenset()
    long_value_spellings: frozenset[str] = frozenset()
    long_optional_spellings: frozenset[str] = frozenset()
    long_spellings: tuple[str, ...] = ()
    int_dests: frozenset[str] = frozenset()
    float_dests: frozenset[str] = frozenset()
    kind_of: dict[str, ValueType] = field(default_factory=dict)
    kind_by_dest: dict[str, ValueType] = field(default_factory=dict)
    dest: dict[str, str] = field(default_factory=dict)
    multiple_dests: frozenset[str] = frozenset()
    count_dests: frozenset[str] = frozenset()
    choices_by_dest: dict[str, tuple[str, ...]] = field(default_factory=dict)
    required_dests: tuple[str, ...] = ()
    defaults: dict[str, str] = field(default_factory=dict)
    env_by_dest: dict[str, str] = field(default_factory=dict)
    numeric_dest: str | None = None
    rest_kind: ValueType | None = None
    base_dest: str | None = None
    nargs_by_dest: dict[str, int] = field(default_factory=dict)
    value_types_by_dest: dict[str, tuple[ValueType, ...]] = field(
        default_factory=dict
    )
    detached_optional_spellings: frozenset[str] = frozenset()
    remainder: bool = False

    def dest_of(self, spelling: str) -> str:
        """Canonical spelling for a typed spelling.

        Args:
            spelling (str): dashed spelling as typed.
        """
        return self.dest.get(spelling, spelling)


# git's notation for an option parse-options also answers as
# `--no-<name>`, and the prefix itself.
NEGATABLE = "[no-]"
NO = "no-"


def _git_spelling(long: str, unset: bool) -> str:
    """The long spelling one of git's options answers to, negated or not.

    Args:
        long (str): the option's name in git's table.
        unset (bool): whether it was matched negated.
    """
    if not unset:
        return f"--{long}"
    return f"--{long[len(NO) :]}" if long.startswith(NO) else f"--{NO}{long}"


def _git_shown(long: str, unset: bool) -> str:
    """How git names a candidate in its ambiguity refusal.

    Args:
        long (str): the option's name in git's table.
        unset (bool): whether it was matched negated.
    """
    return f"--{NO if unset else ''}{long}"


def expand_git_long(
    table: Sequence[str], typed: str
) -> str | tuple[str, str] | None:
    """git's parse-options resolution of one long option against the
    program's own table, which lists each option in git's ``--[no-]``
    notation.

    An exact name wins at once, a negatable option answering to its
    ``--no-`` form too. Otherwise the word may abbreviate one option,
    ``--no-`` abbreviating a negation, and a word that abbreviates two
    is ambiguous: git names the last two it found, each with the ``no-``
    it was matched under. A word matching nothing is None, and the
    caller decides what that is. A string is the spelling the table
    resolves to, which the spec may or may not declare; a pair is the
    two candidates of an ambiguity.

    Args:
        table (Sequence[str]): the program's long options, e.g.
            ``("[no-]verbose", "contains")``.
        typed (str): the word as typed, ``--`` included and any
            ``=value`` removed.
    """
    arg = typed[2:]
    found: tuple[str, bool] | None = None
    earlier: tuple[str, bool] | None = None
    for entry in table:
        negatable = entry.startswith(NEGATABLE)
        long = entry[len(NEGATABLE) :] if negatable else entry
        inverted = not arg.startswith(NO) and negatable and long.startswith(NO)
        name = long[len(NO) :] if inverted else long
        unset = False
        exact = arg == name
        abbreviated = not exact and name.startswith(arg)
        if not exact and not abbreviated and negatable:
            if NO.startswith(arg):
                unset = True
                abbreviated = True
            elif arg.startswith(NO):
                unset = True
                exact = arg[len(NO) :] == name
                abbreviated = not exact and name.startswith(arg[len(NO) :])
        if exact:
            return _git_spelling(long, unset != inverted)
        if abbreviated:
            earlier = found
            found = (long, unset != inverted)
    if found is None:
        return None
    if earlier is not None:
        return _git_shown(*earlier), _git_shown(*found)
    return _git_spelling(*found)


def expand_long(
    cs: CompiledSpec, spelling: str, synonyms: Mapping[str, str] | None = None
) -> tuple[str, ...]:
    """getopt_long prefix matching for a long spelling.

    An exact declared spelling always wins (GNU: ``--binary`` never
    trips over ``--binary-files``); otherwise the candidates are every
    declared long the typed spelling prefixes. Two declared options are
    two options, so a prefix of both is ambiguous (``ls --re`` is
    ``--reverse`` or ``--recursive``), unless ``synonyms`` names them
    one option under two names, the way glibc treats several table
    entries sharing one ``val`` (``grep --colo`` resolves despite
    ``--color``/``--colour`` being separate entries); then the prefix
    resolves to the first. The result length tells the caller
    everything: 0 unknown, 1 match, 2+ ambiguous (every matching
    spelling in declaration order, the order GNU lists possibilities,
    synonyms included like GNU's own listing).

    Args:
        cs (CompiledSpec): compiled tables to match against.
        spelling (str): the typed long spelling, without any ``=value``.
        synonyms (Mapping[str, str] | None): long spelling to the long it
            is another name for, from LONG_SYNONYMS; None when the
            grammar has none.
    """
    if spelling in cs.dest:
        return (spelling,)
    if len(spelling) <= 2:
        return ()
    matches = tuple(
        declared
        for declared in cs.long_spellings
        if declared.startswith(spelling)
    )
    if not matches:
        return ()
    same = synonyms or {}
    if len({same.get(declared, declared) for declared in matches}) == 1:
        return (matches[0],)
    return matches


def expand_table_long(
    table: Sequence[Sequence[str]], spelling: str
) -> tuple[str, ...]:
    """getopt_long prefix matching against a program's whole table.

    An entry spelled exactly names its option; otherwise every entry the
    typed spelling prefixes is a candidate. glibc sets aside a later
    candidate that names the same option as the first one, so one
    option's aliases resolve where two options are ambiguous. The result
    length tells the caller everything: 0 unknown, 1 the option's primary
    spelling, 2+ the possibilities glibc lists (the first candidate and
    every later one naming another option, in table order).

    Args:
        table (Sequence[Sequence[str]]): each option's primary spelling
            then its aliases, in the program's table order
            (LONG_OPTION_TABLES).
        spelling (str): the typed long spelling, without any ``=value``.
    """
    entries = [(name, group[0]) for group in table for name in group]
    for name, primary in entries:
        if name == spelling:
            return (primary,)
    if len(spelling) <= 2:
        return ()
    matches = [
        (name, primary)
        for name, primary in entries
        if name.startswith(spelling)
    ]
    if not matches:
        return ()
    first = matches[0][1]
    listed = (
        matches[0][0],
        *(name for name, primary in matches[1:] if primary != first),
    )
    return (first,) if len(listed) == 1 else listed


@lru_cache(maxsize=512)
def compile_spec(spec: CommandSpec) -> CompiledSpec:
    """Lower a CommandSpec into parser lookup tables.

    Args:
        spec (CommandSpec): the declarative spec to compile.
    """
    seen_spellings: set[str] = set()
    bool_spellings: set[str] = set()
    value_spellings: list[str] = []
    attach_spellings: list[str] = []
    long_bool_spellings: set[str] = set()
    long_value_spellings: set[str] = set()
    long_optional_spellings: set[str] = set()
    long_spellings: list[str] = []
    int_dests: set[str] = set()
    float_dests: set[str] = set()
    kind_of: dict[str, ValueType] = {}
    kind_by_dest: dict[str, ValueType] = {}
    dest: dict[str, str] = {}
    multiple_dests: set[str] = set()
    nargs_by_dest: dict[str, int] = {}
    count_dests: set[str] = set()
    choices_by_dest: dict[str, tuple[str, ...]] = {}
    required_dests: list[str] = []
    defaults: dict[str, str] = {}
    env_by_dest: dict[str, str] = {}
    numeric_dest: str | None = None

    options, positional, rest = argument_shapes(spec)
    for opt in options:
        canonical = argument_dest(opt)
        for spelling in opt.names:
            if spelling in seen_spellings:
                raise ValueError(f"duplicate option spelling {spelling!r}")
            seen_spellings.add(spelling)
        if opt.action in ("store_true", "count") and (
            opt.choices or opt.default is not None
        ):
            raise ValueError(
                f"option {canonical!r}: choices and default "
                "require a value flag"
            )
        if (
            opt.choices
            and opt.default is not None
            and opt.default not in opt.choices
        ):
            raise ValueError(
                f"option {canonical!r}: default "
                f"{opt.default!r} is not one of its choices"
            )
        if opt.type == "int":
            if opt.default is not None and not INT_VALUE.match(opt.default):
                raise ValueError(
                    f"option {canonical!r}: default "
                    f"{opt.default!r} is not an integer"
                )
            int_dests.add(canonical)
        if opt.type == "float":
            if opt.default is not None and not FLOAT_VALUE.match(opt.default):
                raise ValueError(
                    f"option {canonical!r}: default "
                    f"{opt.default!r} is not a number"
                )
            float_dests.add(canonical)
        for spelling in opt.names:
            dest[spelling] = canonical
        if opt.action not in ("store_true", "count"):
            kind_by_dest[canonical] = opt.type
        if opt.action in ("append", "extend"):
            multiple_dests.add(canonical)
        if isinstance(opt.nargs, int):
            nargs_by_dest[canonical] = opt.nargs
        if opt.action == "count":
            count_dests.add(canonical)
        if opt.choices:
            choices_by_dest[canonical] = opt.choices
        if opt.required:
            required_dests.append(canonical)
        if opt.default is not None:
            defaults[canonical] = opt.default
        if opt.env is not None:
            env_by_dest[canonical] = opt.env

        for spelling in opt.names:
            if spelling.startswith("--"):
                long_spellings.append(spelling)
                if opt.action in ("store_true", "count"):
                    long_bool_spellings.add(spelling)
                elif opt.nargs == "?":
                    long_bool_spellings.add(spelling)
                    long_optional_spellings.add(spelling)
                    kind_of[spelling] = opt.type
                else:
                    long_value_spellings.add(spelling)
                    kind_of[spelling] = opt.type
            elif opt.action in ("store_true", "count"):
                bool_spellings.add(spelling)
            elif opt.nargs == "?":
                bool_spellings.add(spelling)
                if opt.short_value:
                    attach_spellings.append(spelling)
                kind_of[spelling] = opt.type
            else:
                value_spellings.append(spelling)
                kind_of[spelling] = opt.type
                if opt.numeric_shorthand:
                    numeric_dest = canonical

    for operand in (*positional, *((rest,) if rest is not None else ())):
        argument = operand
        name = argument.names[0]
        if argument.type == "int":
            int_dests.add(name)
        elif argument.type == "float":
            float_dests.add(name)
        if argument.choices:
            choices_by_dest[name] = argument.choices

    base_dest: str | None = None
    if spec.operand_base is not None:
        base_dest = dest.get(spec.operand_base)
        if base_dest is None:
            raise ValueError(
                f"operand_base {spec.operand_base!r} is not a declared option"
            )
        if kind_by_dest.get(base_dest) != "path" or base_dest in nargs_by_dest:
            raise ValueError(
                f"operand_base {spec.operand_base!r} must be a "
                "single-token path option"
            )

    # Longest first so an attached match can never be stolen by a
    # shorter spelling that happens to prefix it (-name vs -n).
    value_spellings.sort(key=len, reverse=True)
    attach_spellings.sort(key=len, reverse=True)

    return CompiledSpec(
        options=options,
        positional=positional,
        rest=rest,
        nargs_by_dest=nargs_by_dest,
        value_types_by_dest={
            argument_dest(opt): opt.value_types
            for opt in options
            if opt.value_types
        },
        detached_optional_spellings=frozenset(
            name
            for opt in options
            if opt.nargs == "?" and not opt.attached_only
            for name in opt.names
        ),
        bool_spellings=frozenset(bool_spellings),
        value_spellings=tuple(value_spellings),
        attach_spellings=tuple(attach_spellings),
        long_bool_spellings=frozenset(long_bool_spellings),
        long_value_spellings=frozenset(long_value_spellings),
        long_optional_spellings=frozenset(long_optional_spellings),
        long_spellings=tuple(long_spellings),
        int_dests=frozenset(int_dests),
        float_dests=frozenset(float_dests),
        kind_of=kind_of,
        kind_by_dest=kind_by_dest,
        dest=dest,
        multiple_dests=frozenset(multiple_dests),
        count_dests=frozenset(count_dests),
        choices_by_dest=choices_by_dest,
        required_dests=tuple(required_dests),
        defaults=defaults,
        env_by_dest=env_by_dest,
        numeric_dest=numeric_dest,
        rest_kind=rest.type if rest is not None else None,
        base_dest=base_dest,
        remainder=rest is not None and rest.nargs == "REMAINDER",
    )
