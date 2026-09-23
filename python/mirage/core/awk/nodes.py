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
from enum import StrEnum


class Expr:
    __slots__ = ()


class Stmt:
    __slots__ = ()


class RuleKind(StrEnum):
    BEGIN = "BEGIN"
    END = "END"
    ALWAYS = "ALWAYS"
    PATTERN = "PATTERN"
    RANGE = "RANGE"


class RedirKind(StrEnum):
    FILE = ">"
    APPEND = ">>"
    PIPE = "|"


class GetlineKind(StrEnum):
    PLAIN = "PLAIN"
    FILE = "FILE"
    CMD = "CMD"


@dataclass(frozen=True, slots=True)
class Num(Expr):
    value: float


@dataclass(frozen=True, slots=True)
class Str(Expr):
    value: str


@dataclass(frozen=True, slots=True)
class Regex(Expr):
    pattern: str


@dataclass(frozen=True, slots=True)
class Var(Expr):
    name: str


@dataclass(frozen=True, slots=True)
class Field(Expr):
    index: Expr


@dataclass(frozen=True, slots=True)
class ArrayRef(Expr):
    name: str
    subscripts: tuple[Expr, ...]


@dataclass(frozen=True, slots=True)
class Assign(Expr):
    target: Expr
    op: str
    value: Expr


@dataclass(frozen=True, slots=True)
class Binary(Expr):
    op: str
    left: Expr
    right: Expr


@dataclass(frozen=True, slots=True)
class Unary(Expr):
    op: str
    operand: Expr


@dataclass(frozen=True, slots=True)
class Concat(Expr):
    left: Expr
    right: Expr


@dataclass(frozen=True, slots=True)
class Compare(Expr):
    op: str
    left: Expr
    right: Expr


@dataclass(frozen=True, slots=True)
class MatchOp(Expr):
    negated: bool
    left: Expr
    right: Expr


@dataclass(frozen=True, slots=True)
class Logical(Expr):
    op: str
    left: Expr
    right: Expr


@dataclass(frozen=True, slots=True)
class Not(Expr):
    operand: Expr


@dataclass(frozen=True, slots=True)
class Ternary(Expr):
    cond: Expr
    then: Expr
    other: Expr


@dataclass(frozen=True, slots=True)
class IncDec(Expr):
    pre: bool
    op: str
    target: Expr


@dataclass(frozen=True, slots=True)
class Call(Expr):
    name: str
    args: tuple[Expr, ...]


@dataclass(frozen=True, slots=True)
class BuiltinCall(Expr):
    name: str
    args: tuple[Expr, ...]


@dataclass(frozen=True, slots=True)
class InArray(Expr):
    subscripts: tuple[Expr, ...]
    name: str


@dataclass(frozen=True, slots=True)
class Getline(Expr):
    kind: GetlineKind
    target: Expr | None
    source: Expr | None


@dataclass(frozen=True, slots=True)
class Redirect:
    kind: RedirKind
    target: Expr


@dataclass(frozen=True, slots=True)
class Block(Stmt):
    body: tuple[Stmt, ...]


@dataclass(frozen=True, slots=True)
class ExprStmt(Stmt):
    expr: Expr


@dataclass(frozen=True, slots=True)
class Print(Stmt):
    args: tuple[Expr, ...]
    redirect: Redirect | None


@dataclass(frozen=True, slots=True)
class Printf(Stmt):
    args: tuple[Expr, ...]
    redirect: Redirect | None


@dataclass(frozen=True, slots=True)
class If(Stmt):
    cond: Expr
    then: Stmt
    other: Stmt | None


@dataclass(frozen=True, slots=True)
class While(Stmt):
    cond: Expr
    body: Stmt


@dataclass(frozen=True, slots=True)
class DoWhile(Stmt):
    body: Stmt
    cond: Expr


@dataclass(frozen=True, slots=True)
class For(Stmt):
    init: Stmt | None
    cond: Expr | None
    post: Stmt | None
    body: Stmt


@dataclass(frozen=True, slots=True)
class ForIn(Stmt):
    var: str
    array: str
    body: Stmt


@dataclass(frozen=True, slots=True)
class Next(Stmt):
    pass


@dataclass(frozen=True, slots=True)
class NextFile(Stmt):
    pass


@dataclass(frozen=True, slots=True)
class Break(Stmt):
    pass


@dataclass(frozen=True, slots=True)
class Continue(Stmt):
    pass


@dataclass(frozen=True, slots=True)
class Exit(Stmt):
    value: Expr | None


@dataclass(frozen=True, slots=True)
class Return(Stmt):
    value: Expr | None


@dataclass(frozen=True, slots=True)
class Delete(Stmt):
    name: str
    subscripts: tuple[Expr, ...] | None


@dataclass(frozen=True, slots=True)
class Rule:
    kind: RuleKind
    pattern: Expr | None
    pattern_end: Expr | None
    action: Block | None


@dataclass(frozen=True, slots=True)
class FuncDef:
    name: str
    params: tuple[str, ...]
    body: Block


@dataclass(frozen=True, slots=True)
class Program:
    rules: tuple[Rule, ...] = ()
    functions: dict[str, FuncDef] = field(default_factory=dict)


__all__ = [
    "ArrayRef",
    "Assign",
    "Binary",
    "Block",
    "Break",
    "BuiltinCall",
    "Call",
    "Compare",
    "Concat",
    "Continue",
    "Delete",
    "DoWhile",
    "Exit",
    "Expr",
    "ExprStmt",
    "Field",
    "For",
    "ForIn",
    "FuncDef",
    "Getline",
    "GetlineKind",
    "If",
    "InArray",
    "IncDec",
    "Logical",
    "MatchOp",
    "Next",
    "NextFile",
    "Not",
    "Num",
    "Print",
    "Printf",
    "Program",
    "RedirKind",
    "Redirect",
    "Regex",
    "Return",
    "Rule",
    "RuleKind",
    "Stmt",
    "Str",
    "Ternary",
    "Unary",
    "Var",
    "While",
]
