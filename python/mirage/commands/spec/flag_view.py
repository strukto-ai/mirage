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
from typing import Generic, TypeVar

from mirage.commands.spec.constants import (
    OPERAND,
    REFUSED,
    SPELLED,
    flag_kwarg_name,
)
from mirage.commands.spec.types import CommandSpec, FlagValue
from mirage.types import PathSpec

T = TypeVar("T")

# The tape names no option declares: they mark operands and refusals.
_TAPE_ONLY = frozenset({OPERAND, REFUSED, SPELLED})


class FlagBag(dict[str, T], Generic[T]):
    """Flag values with a separate tape of occurrences in scan order.

    The tape holds each option occurrence as (dest, value), each operand
    as (OPERAND, word), for a program that runs its own option loop each
    refused option as (REFUSED, word), and each SPELLED_WORDS word as
    (SPELLED, word), so it also says which options were typed before an
    operand or a refusal.

    Args:
        values (Mapping[str, T] | None): Values to copy, preserving their tape.
    """

    def __init__(self, values: Mapping[str, T] | None = None) -> None:
        super().__init__(values or {})
        self.occurrences: list[tuple[str, str | bool | int]] = (
            list(values.occurrences) if isinstance(values, FlagBag) else []
        )


def spread_operands(
    flags: Mapping[str, FlagValue], groups: Sequence[Sequence[str]]
) -> FlagBag[FlagValue]:
    """The flags with each operand's tape entry spread over its words.

    The parse runs before a glob expands, so the tape holds an operand
    as it was typed. A program that reads its operands in order (join)
    needs each match where the glob stood, as its argv would hold them.
    A tape that does not place exactly these operands is kept as it is.

    Args:
        flags (Mapping[str, FlagValue]): parsed flags and their tape.
        groups (Sequence[Sequence[str]]): each operand's words, in order,
            a glob's matches in its place.
    """
    bag = FlagBag(flags)
    placed = [name for name, _ in bag.occurrences if name == OPERAND]
    if len(placed) != len(groups):
        return bag
    words = iter(groups)
    bag.occurrences = [
        entry
        for name, value in bag.occurrences
        for entry in (
            [(OPERAND, word) for word in next(words)]
            if name == OPERAND
            else [(name, value)]
        )
    ]
    return bag


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

    def __init__(
        self,
        flags: Mapping[str, FlagValue] | None,
        spec: CommandSpec | None = None,
    ) -> None:
        self._flags = flags if flags is not None else {}
        self._allowed = spec_flag_names(spec) if spec is not None else None

    def _key(self, name: str) -> str:
        if self._allowed is not None and name not in self._allowed:
            raise KeyError(
                f"flag {name!r} is not declared by the command "
                f"spec (known: {sorted(self._allowed)})"
            )
        return name

    def typed_order(self, *names: str) -> list[str]:
        """The given flag names, ordered by their recorded occurrences.

        The parser fills the bag in scan order and every hop between
        (kwargs, dict copies) preserves insertion order, so a key's
        position is its last occurrence for a scalar, or its first for an
        accumulating option; a flag supplied
        by a default or the environment lands after every typed one.
        Names the line never carried are dropped. This is what an
        order-sensitive option family (grep's --include/--exclude,
        where the later kind overrides the earlier) reads, since the
        bag has no per-occurrence positions.

        Args:
            names (str): flag names to order.
        """
        wanted = {self._key(n) for n in names}
        return [k for k in self._flags if k in wanted]

    def occurrences(self, *names: str) -> list[tuple[str, FlagValue]]:
        """Read each typed occurrence, then defaults without a typed value.

        OPERAND among the names reads the operands too, each as
        (OPERAND, word) where it was typed among the options, and REFUSED
        and SPELLED read the refused options and the spelled words the
        same way. Flags with no tape (keywords) have none of them.

        Args:
            names (str): Spec-bound option names to read, OPERAND,
                REFUSED and SPELLED.
        """
        wanted = {
            name if name in _TAPE_ONLY else self._key(name) for name in names
        }
        tape = (
            self._flags.occurrences if isinstance(self._flags, FlagBag) else []
        )
        result: list[tuple[str, FlagValue]] = [
            (name, value)
            for name, value in tape
            if name in wanted and (name in _TAPE_ONLY or name in self._flags)
        ]
        seen = {name for name, _ in result}
        for name in self.typed_order(*(wanted - _TAPE_ONLY)):
            if name not in seen:
                value = self._flags[name]
                if isinstance(value, list):
                    result.extend((name, item) for item in value)
                else:
                    result.append((name, value))
        return result

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
            raise ValueError(
                f"flag '{name}' expects an integer, got '{value}'"
            ) from exc

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
            raise ValueError(
                f"flag '{name}' expects a number, got '{value}'"
            ) from exc

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

    def as_path(self, name: str) -> PathSpec | None:
        value = self._flags.get(self._key(name))
        return value if isinstance(value, PathSpec) else None

    def as_paths(self, name: str) -> list[PathSpec]:
        # PATH-typed flag values arrive as PathSpec. Mirrors TS asPaths.
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
