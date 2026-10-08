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


@dataclass(frozen=True, slots=True)
class HeredocOperator:
    """One ``<<`` or ``<<-`` operator as the source spells it.

    Attributes:
        word_start (int): byte offset of the delimiter word.
        word_end (int): byte offset just past the delimiter word.
        delimiter (str): the delimiter as bash reads it, quotes removed.
        allows_indent (bool): whether the operator was ``<<-``.
    """

    word_start: int
    word_end: int
    delimiter: str
    allows_indent: bool


@dataclass(frozen=True, slots=True)
class Heredoc:
    """One source-owned body, its delimiter, and reader diagnostics."""

    operator_start: int
    word_end: int
    delimiter: str
    quoted: bool
    body_start: int
    end: int
    body: bytes
    offsets: tuple[int, ...]
    terminated: bool
    line: int
    eof_line: int


@dataclass(frozen=True, slots=True)
class HeredocPlan:
    """The heredocs bash reads in a line, as its reader takes them.

    Attributes:
        order (tuple[tuple[int, int, int], ...]): each heredoc's ``<<``
            and where its body starts and ends (past its terminator), in
            the order bash reads the bodies.
        closes (tuple[tuple[int, tuple[int, ...]], ...]): each
            substitution that closes with bodies still to read: its ``)``
            and those heredocs' ``<<``, which bash warns of.
    """

    order: tuple[tuple[int, int, int], ...]
    closes: tuple[tuple[int, tuple[int, ...]], ...]


@dataclass(frozen=True, slots=True)
class HeredocSource:
    """Lowered source plus a map back to original byte locations."""

    original: bytes
    source: bytes
    offsets: tuple[int, ...]
    documents: tuple[tuple[int, Heredoc], ...]
    closes: tuple[tuple[int, tuple[int, ...]], ...] = ()


@dataclass(frozen=True, slots=True)
class BodyRead:
    """A completed read, including the shell reader line at EOF."""

    body: bytes
    offsets: tuple[int, ...]
    end: int
    terminated: bool
    eof_line: int
