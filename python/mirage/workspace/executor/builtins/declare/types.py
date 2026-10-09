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

from typing import NamedTuple

from mirage.shell.variable import VarAttr, VarKind

# A staged array literal, `NAME=(...)` or `NAME+=(...)`: the name, whether
# it appends, and its expanded items. It travels as data so the builtin
# that owns the keyword stores it through the session view.
StagedArray = tuple[str, bool, list[str]]
# One declaration operand in the order it was typed: a word (`NAME`,
# `NAME=value`, an option) or a staged array literal.
DeclarationOperand = str | StagedArray
# The attribute letters a declaration applies, in order: each attribute
# and whether it goes on (`-x`) or off (`+x`).
AttrMarks = tuple[tuple[VarAttr, bool], ...]


class Declaration(NamedTuple):
    """How a ``local``, ``declare`` or ``typeset`` runs its operands.

    Attributes:
        cmd (str): the spelling that reached here, for diagnostics.
            ``declare`` and ``typeset`` route through ``handle_local`` and
            must say their own name, not ``local``.
        kind (VarKind | None): the kind ``-a`` / ``-A`` declared, so
            staged literals build that kind of array.
        shaping (AttrMarks): the value-shaping marks (``-i -l -u``,
            ``+i +l +u``) the declaration carries. They go on or off each
            name *before* its value stores, after the local snapshot, so
            the declaration's own value coerces exactly as a later write
            would: GNU stores ``7`` for ``declare -i n=3+4``, ``hello``
            for ``declare -l s=HeLLo`` and ``5x`` for ``declare +i
            N+=x`` over an integer 5.
        marks (AttrMarks): the attribute letters to put on or take off
            each operand once it lands (``stamp_marks``), readonly last.
        plus (str): the ``+`` letters, for the two that cannot be taken
            off (``plus_refusal``).
        nameref (bool): the declaration carried ``-n``, so a value names
            the reference's target and is stored on the reference's own
            record, which also takes the marks, rather than written
            through an existing one.
        global_scope (bool): the declaration carried ``-g``, so inside a
            function the names are declared globally: no local snapshot
            is taken, and a name the function already shadows has its
            *global* record read, written and marked (``reach_global``).
        inherit (bool): the declaration carried ``-I``, so a new local
            keeps the shadowed variable's value and attributes but a
            reference (``start_local``).
    """

    cmd: str = "local"
    kind: VarKind | None = None
    shaping: AttrMarks = ()
    marks: AttrMarks = ()
    plus: str = ""
    nameref: bool = False
    global_scope: bool = False
    inherit: bool = False
