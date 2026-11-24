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

from mirage.core.posix.types import PosixEntry


@dataclass(frozen=True, slots=True)
class Holder:
    """One machine holding a name, and what it reports for it.

    Args:
        machine (str): the machine's name under ``machines:``.
        entry (PosixEntry | None): the name's entry on that machine; None
            on a mount that shows one machine, which is not asked.
    """

    machine: str
    entry: PosixEntry | None = None

    @property
    def is_folder(self) -> bool:
        """Whether the machine holds a directory at the name; False when
        it was not asked."""
        return self.entry is not None and self.entry.kind == "d"

    @property
    def written_ms(self) -> int:
        """When the machine's copy was last written, in epoch
        milliseconds by its own clock; 0 when it was not asked."""
        return self.entry.mtime_ms if self.entry is not None else 0


@dataclass(frozen=True, slots=True)
class Copies:
    """Every machine's copy of a name some machine holds, and the copy
    every look at it goes to.

    Args:
        held (tuple[Holder, ...]): the machines holding the name, in the
            order ``machines:`` lists them.
        shown (Holder): the copy every look goes to (``place.chosen``).
    """

    held: tuple[Holder, ...]
    shown: Holder

    @property
    def machines(self) -> list[str]:
        """The machines holding the name."""
        return [one.machine for one in self.held]

    @property
    def folders(self) -> list[str]:
        """The machines holding the name as a folder."""
        return [one.machine for one in self.held if one.is_folder]

    @property
    def others(self) -> list[Holder]:
        """The copies other than the one shown."""
        return [one for one in self.held if one is not self.shown]


@dataclass(frozen=True, slots=True)
class Landing:
    """Where a write lands on a mount's machines, and how.

    Args:
        machine (str): the machine the bytes land on.
        origin (bool): the bytes come from that machine (a program's
            ``>``, a copy), so the write replaces the name across the
            machines: no other machine's copy of it stays.
        make_parent (bool): the name's folder must be made there first,
            since only other machines hold it.
    """

    machine: str
    origin: bool = False
    make_parent: bool = False
