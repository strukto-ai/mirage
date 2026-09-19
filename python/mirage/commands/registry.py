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

from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, TypeAlias, overload

from mirage.commands.config import RegisteredCommand, command, cross_command

_CommandSource: TypeAlias = RegisteredCommand | Callable[..., Any]


def registered_commands(
        items: Iterable[_CommandSource]) -> list[RegisteredCommand]:
    """Flatten command sources into their registrations, in order.

    Args:
        items (Iterable[_CommandSource]): ``RegisteredCommand`` values
            and ``@command``-decorated functions, each of which may
            carry several registrations.

    Raises:
        TypeError: an item is neither.
    """
    values: list[RegisteredCommand] = []
    for item in items:
        registrations = ([item] if isinstance(item, RegisteredCommand) else
                         getattr(item, "_registered_commands", None))
        if registrations is None:
            raise TypeError(
                "command catalogs require RegisteredCommand values or "
                "@command-decorated functions")
        for registered in registrations:
            if not isinstance(registered, RegisteredCommand):
                raise TypeError("command catalog registrations must be "
                                "RegisteredCommand values")
            values.append(registered)
    return values


@dataclass(frozen=True, slots=True, init=False)
class CommandCatalog(Sequence[RegisteredCommand]):
    """Immutable command table with exact name/filetype lookup."""

    _items: tuple[RegisteredCommand, ...]
    _by_key: Mapping[tuple[str, str | None],
                     RegisteredCommand] = field(repr=False)

    def __init__(self, items: Iterable[_CommandSource]) -> None:
        values = registered_commands(items)
        by_key: dict[tuple[str, str | None], RegisteredCommand] = {}
        for registered in values:
            by_key[(registered.name, registered.filetype)] = registered
        object.__setattr__(self, "_items", tuple(values))
        object.__setattr__(self, "_by_key", MappingProxyType(by_key))

    def __len__(self) -> int:
        return len(self._items)

    @overload
    def __getitem__(self, index: int) -> RegisteredCommand:
        ...

    @overload
    def __getitem__(self, index: slice) -> Sequence[RegisteredCommand]:
        ...

    def __getitem__(
            self, index: int | slice
    ) -> RegisteredCommand | Sequence[RegisteredCommand]:
        return self._items[index]

    def __iter__(self) -> Iterator[RegisteredCommand]:
        return iter(self._items)

    def get(self,
            name: str,
            filetype: str | None = None) -> RegisteredCommand | None:
        return self._by_key.get((name, filetype))

    def require(self,
                name: str,
                filetype: str | None = None) -> RegisteredCommand:
        command = self.get(name, filetype)
        if command is None:
            message = (f"command {name!r} with filetype {filetype!r} "
                       "is not registered")
            raise KeyError(message)
        return command


__all__ = [
    "CommandCatalog",
    "RegisteredCommand",
    "command",
    "cross_command",
]
