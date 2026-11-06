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

from collections.abc import Callable, Iterator, Mapping, MutableMapping
from functools import lru_cache
from typing import TypeAlias

from mirage._rs import Shell
from mirage.shell.array import ShellArray
from mirage.shell.variable import (
    ManagedRef,
    ShellValue,
    ShellVar,
    VarAttr,
    attr_letters,
)
from mirage.utils.ids import SystemIdSource

RawValue: TypeAlias = str | dict[int, str] | dict[str, str] | None
Managed: TypeAlias = tuple[str, str, str, bool]
Record: TypeAlias = tuple[RawValue, str, Managed | None]

_LETTERS = {attr.value: attr for attr in VarAttr}


@lru_cache(maxsize=256)
def _attrs(cluster: str) -> frozenset[VarAttr]:
    return frozenset(_LETTERS[c] for c in cluster if c in _LETTERS)


def var_of(record: Record) -> ShellVar:
    """The record mirage-rs holds as a ``ShellVar``.

    Args:
        record (Record): ``(value, cluster, managed)``, the cluster
            leading with ``a`` or ``A`` for an array.
    """
    raw, cluster, managed = record
    value: ShellValue | None
    if isinstance(raw, dict) and not cluster.startswith("A"):
        value = ShellArray(raw)  # type: ignore[arg-type]
    else:
        value = raw  # type: ignore[assignment]
    return ShellVar(
        value,
        _attrs(cluster),
        None if managed is None else ManagedRef(*managed),
    )


def record_of(var: ShellVar) -> Record:
    """A ``ShellVar`` as the record mirage-rs holds.

    Args:
        var (ShellVar): the variable.
    """
    value = var.value
    raw: RawValue = (
        dict(value.elements) if isinstance(value, ShellArray) else value
    )
    ref = var.managed
    managed = (
        None if ref is None else (ref.source, ref.ref, ref.key, ref.eager)
    )
    return raw, attr_letters(var), managed


def raw_value(value: ShellValue) -> tuple[RawValue, bool]:
    """A value as mirage-rs takes it, and whether it is associative.

    Args:
        value (ShellValue): the value.
    """
    if isinstance(value, ShellArray):
        return dict(value.elements), False
    return value, isinstance(value, dict)


class ShellVars(MutableMapping[str, ShellVar]):
    """A session's variables, held by its mirage-rs ``Shell``.

    The records read and write as ``ShellVar``; a write here is shell
    bookkeeping, never a line's, which runs through the shell's gated
    writes.

    Args:
        shell (Shell): the shell holding the records.
    """

    __slots__ = ("shell",)

    def __init__(self, shell: Shell) -> None:
        self.shell = shell

    @classmethod
    def of(
        cls,
        table: Mapping[str, ShellVar],
        ids: Callable[[], int] | None = None,
    ) -> "ShellVars":
        """A new shell holding ``table``.

        Args:
            table (Mapping[str, ShellVar]): the records.
            ids (Callable[[], int] | None): where a fresh ``$RANDOM``
                seeds; None is the platform's randomness, until a session
                binds its own source.
        """
        out = cls(Shell(ids or SystemIdSource().random_u32))
        for name, var in table.items():
            out.shell.place(name, record_of(var))
        return out

    def __getitem__(self, name: str) -> ShellVar:
        record = self.shell.get(name)
        if record is None:
            raise KeyError(name)
        return var_of(record)

    def get(  # type: ignore[override]
        self, name: str, default: ShellVar | None = None
    ) -> ShellVar | None:
        record = self.shell.get(name)
        return default if record is None else var_of(record)

    def __setitem__(self, name: str, var: ShellVar) -> None:
        self.shell.place(name, record_of(var))

    def __delitem__(self, name: str) -> None:
        if self.shell.place(name, None) is None:
            raise KeyError(name)

    def pop(  # type: ignore[override]
        self, name: str, default: ShellVar | None = None
    ) -> ShellVar | None:
        old = self.shell.place(name, None)
        return default if old is None else var_of(old)

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and name in self.shell

    def __iter__(self) -> Iterator[str]:
        return iter(self.shell.names())

    def __len__(self) -> int:
        return len(self.shell)

    def items(self) -> list[tuple[str, ShellVar]]:  # type: ignore[override]
        return self.records()

    def records(self) -> list[tuple[str, ShellVar]]:
        """Every record, in no order, in one call."""
        return [
            (name, var_of(record)) for name, record in self.shell.records()
        ]

    def fork(self) -> "ShellVars":
        """A copy for a fork of the session."""
        return ShellVars(self.shell.fork())

    def subshell(self) -> "ShellVars":
        """A child shell's copy: the scopes too, ``$RANDOM`` anew."""
        return ShellVars(self.shell.subshell())
