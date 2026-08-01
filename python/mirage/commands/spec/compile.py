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

from dataclasses import dataclass, field
from functools import lru_cache

from mirage.commands.spec.types import CommandSpec, OperandKind


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
        kind_of (dict[str, OperandKind]): value kind per spelling.
        kind_by_dest (dict[str, OperandKind]): value kind per canonical
            spelling, for post-parse PATH/TEXT value collection.
        dest (dict[str, str]): spelling -> canonical spelling.
        multiple_dests (frozenset[str]): canonical spellings that
            accumulate repeated values into a list.
        numeric_dest (str | None): canonical spelling fed by the
            ``-<digits>`` shorthand, when one option declares it.
        rest_kind (OperandKind | None): kind of the rest operand.
    """

    bool_spellings: frozenset[str] = frozenset()
    value_spellings: tuple[str, ...] = ()
    attach_spellings: tuple[str, ...] = ()
    long_bool_spellings: frozenset[str] = frozenset()
    long_value_spellings: frozenset[str] = frozenset()
    long_optional_spellings: frozenset[str] = frozenset()
    kind_of: dict[str, OperandKind] = field(default_factory=dict)
    kind_by_dest: dict[str, OperandKind] = field(default_factory=dict)
    dest: dict[str, str] = field(default_factory=dict)
    multiple_dests: frozenset[str] = frozenset()
    numeric_dest: str | None = None
    rest_kind: OperandKind | None = None

    def dest_of(self, spelling: str) -> str:
        """Canonical spelling for a typed spelling.

        Args:
            spelling (str): dashed spelling as typed.
        """
        return self.dest.get(spelling, spelling)


@lru_cache(maxsize=512)
def compile_spec(spec: CommandSpec) -> CompiledSpec:
    """Lower a CommandSpec into parser lookup tables.

    Args:
        spec (CommandSpec): the declarative spec to compile.
    """
    bool_spellings: set[str] = set()
    value_spellings: list[str] = []
    attach_spellings: list[str] = []
    long_bool_spellings: set[str] = set()
    long_value_spellings: set[str] = set()
    long_optional_spellings: set[str] = set()
    kind_of: dict[str, OperandKind] = {}
    kind_by_dest: dict[str, OperandKind] = {}
    dest: dict[str, str] = {}
    multiple_dests: set[str] = set()
    numeric_dest: str | None = None

    for opt in spec.options:
        canonical = opt.long if opt.long else opt.short
        if canonical is None:
            continue
        if opt.short:
            dest[opt.short] = canonical
        if opt.long:
            dest[opt.long] = canonical
        if opt.value_kind != OperandKind.NONE:
            kind_by_dest[canonical] = opt.value_kind
        if opt.repeatable:
            multiple_dests.add(canonical)

        if opt.short:
            if opt.value_kind == OperandKind.NONE:
                bool_spellings.add(opt.short)
            elif opt.value_optional:
                # GNU optional argument: the bare short is boolean and a
                # value only rides attached to the same token.
                bool_spellings.add(opt.short)
                if opt.short_value:
                    attach_spellings.append(opt.short)
                kind_of[opt.short] = opt.value_kind
            else:
                value_spellings.append(opt.short)
                kind_of[opt.short] = opt.value_kind
                if opt.numeric_shorthand:
                    numeric_dest = canonical
        if opt.long:
            if opt.value_kind == OperandKind.NONE:
                long_bool_spellings.add(opt.long)
            elif opt.value_optional:
                # GNU optional argument: bare form is boolean, value only
                # attaches via `=`; a detached next token is an operand.
                long_bool_spellings.add(opt.long)
                long_optional_spellings.add(opt.long)
                kind_of[opt.long] = opt.value_kind
            else:
                long_value_spellings.add(opt.long)
                kind_of[opt.long] = opt.value_kind

    # Longest first so an attached match can never be stolen by a
    # shorter spelling that happens to prefix it (-name vs -n).
    value_spellings.sort(key=len, reverse=True)
    attach_spellings.sort(key=len, reverse=True)

    return CompiledSpec(
        bool_spellings=frozenset(bool_spellings),
        value_spellings=tuple(value_spellings),
        attach_spellings=tuple(attach_spellings),
        long_bool_spellings=frozenset(long_bool_spellings),
        long_value_spellings=frozenset(long_value_spellings),
        long_optional_spellings=frozenset(long_optional_spellings),
        kind_of=kind_of,
        kind_by_dest=kind_by_dest,
        dest=dest,
        multiple_dests=frozenset(multiple_dests),
        numeric_dest=numeric_dest,
        rest_kind=spec.rest.kind if spec.rest is not None else None,
    )
