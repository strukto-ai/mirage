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

from .constants import DEFAULT_BASE


@dataclass(frozen=True, slots=True)
class BcNumber:
    """An exact decimal coefficient with preserved fractional scale.

    Args:
        coefficient (int): the value multiplied by ten to its scale.
        scale (int): the fractional digit count.
    """

    coefficient: int
    scale: int


@dataclass(slots=True)
class BcState:
    """What survives between statements on one bc run.

    Args:
        scale (int): the global `scale` register.
        math_mode (bool): whether `-l` loaded the math library.
        ibase (int): the base numeric literals are read in.
        obase (int): the base results are printed in.
        last (BcNumber): the `last` register, also spelled `.`, holding
            the value of the most recently printed statement.
        variables (dict[str, BcNumber]): the symbol table. The whole
            BcNumber is stored, so a variable carries its own scale.
        warnings (list[str]): runtime warnings raised by the statement
            being evaluated, drained by the caller after each one.
    """

    scale: int
    math_mode: bool
    ibase: int = DEFAULT_BASE
    obase: int = DEFAULT_BASE
    last: BcNumber = BcNumber(0, 0)
    variables: dict[str, BcNumber] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class BcStatement:
    """One bc statement and where its characters came from.

    Args:
        text (str): the statement source, comments already removed.
        lines (tuple[int, ...]): the input line each character of `text`
            sits on. A block comment spanning lines advances the counter
            without ending the statement, so one statement's characters
            can sit on more than one line.
        incomplete_line (int): the line GNU charges an incomplete
            construct to. Its parser fails on whichever token arrives
            next, so that is the `;` ending this statement when one
            does -- `1+;2` reports line 1 -- and otherwise the newline
            after it, which has already moved the counter on, so the
            last statement of a line reports the line after it.
        execute (bool): whether the statement runs. It is False for one
            on a line a `quit` cut short: GNU exits inside the lexer, so
            that line is parsed -- and a parse error still reported --
            but never executed.
    """

    text: str
    lines: tuple[int, ...]
    incomplete_line: int
    execute: bool
