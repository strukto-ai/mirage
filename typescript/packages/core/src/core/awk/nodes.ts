// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

export const RuleKind = {
  BEGIN: 'BEGIN',
  END: 'END',
  ALWAYS: 'ALWAYS',
  PATTERN: 'PATTERN',
  RANGE: 'RANGE',
} as const
export type RuleKind = (typeof RuleKind)[keyof typeof RuleKind]

export const RedirKind = {
  FILE: '>',
  APPEND: '>>',
  PIPE: '|',
} as const
export type RedirKind = (typeof RedirKind)[keyof typeof RedirKind]

export const GetlineKind = {
  PLAIN: 'PLAIN',
  FILE: 'FILE',
  CMD: 'CMD',
} as const
export type GetlineKind = (typeof GetlineKind)[keyof typeof GetlineKind]

export interface Num {
  readonly type: 'Num'
  readonly value: number
}

export interface Str {
  readonly type: 'Str'
  readonly value: string
}

export interface Regex {
  readonly type: 'Regex'
  readonly pattern: string
}

export interface Var {
  readonly type: 'Var'
  readonly name: string
}

export interface Field {
  readonly type: 'Field'
  readonly index: Expr
}

export interface ArrayRef {
  readonly type: 'ArrayRef'
  readonly name: string
  readonly subscripts: readonly Expr[]
}

export interface Assign {
  readonly type: 'Assign'
  readonly target: Expr
  readonly op: string
  readonly value: Expr
}

export interface Binary {
  readonly type: 'Binary'
  readonly op: string
  readonly left: Expr
  readonly right: Expr
}

export interface Unary {
  readonly type: 'Unary'
  readonly op: string
  readonly operand: Expr
}

export interface Concat {
  readonly type: 'Concat'
  readonly left: Expr
  readonly right: Expr
}

export interface Compare {
  readonly type: 'Compare'
  readonly op: string
  readonly left: Expr
  readonly right: Expr
}

export interface MatchOp {
  readonly type: 'MatchOp'
  readonly negated: boolean
  readonly left: Expr
  readonly right: Expr
}

export interface Logical {
  readonly type: 'Logical'
  readonly op: string
  readonly left: Expr
  readonly right: Expr
}

export interface Not {
  readonly type: 'Not'
  readonly operand: Expr
}

export interface Ternary {
  readonly type: 'Ternary'
  readonly cond: Expr
  readonly then: Expr
  readonly other: Expr
}

export interface IncDec {
  readonly type: 'IncDec'
  readonly pre: boolean
  readonly op: string
  readonly target: Expr
}

export interface Call {
  readonly type: 'Call'
  readonly name: string
  readonly args: readonly Expr[]
}

export interface BuiltinCall {
  readonly type: 'BuiltinCall'
  readonly name: string
  readonly args: readonly Expr[]
}

export interface InArray {
  readonly type: 'InArray'
  readonly subscripts: readonly Expr[]
  readonly name: string
}

export interface Getline {
  readonly type: 'Getline'
  readonly kind: GetlineKind
  readonly target: Expr | null
  readonly source: Expr | null
}

export type Expr =
  | Num
  | Str
  | Regex
  | Var
  | Field
  | ArrayRef
  | Assign
  | Binary
  | Unary
  | Concat
  | Compare
  | MatchOp
  | Logical
  | Not
  | Ternary
  | IncDec
  | Call
  | BuiltinCall
  | InArray
  | Getline

export type Lvalue = Var | Field | ArrayRef

export interface Redirect {
  readonly kind: RedirKind
  readonly target: Expr
}

export interface Block {
  readonly type: 'Block'
  readonly body: readonly Stmt[]
}

export interface ExprStmt {
  readonly type: 'ExprStmt'
  readonly expr: Expr
}

export interface Print {
  readonly type: 'Print'
  readonly args: readonly Expr[]
  readonly redirect: Redirect | null
}

export interface Printf {
  readonly type: 'Printf'
  readonly args: readonly Expr[]
  readonly redirect: Redirect | null
}

export interface If {
  readonly type: 'If'
  readonly cond: Expr
  readonly then: Stmt
  readonly other: Stmt | null
}

export interface While {
  readonly type: 'While'
  readonly cond: Expr
  readonly body: Stmt
}

export interface DoWhile {
  readonly type: 'DoWhile'
  readonly body: Stmt
  readonly cond: Expr
}

export interface For {
  readonly type: 'For'
  readonly init: Stmt | null
  readonly cond: Expr | null
  readonly post: Stmt | null
  readonly body: Stmt
}

export interface ForIn {
  readonly type: 'ForIn'
  readonly var: string
  readonly array: string
  readonly body: Stmt
}

export interface Next {
  readonly type: 'Next'
}

export interface NextFile {
  readonly type: 'NextFile'
}

export interface Break {
  readonly type: 'Break'
}

export interface Continue {
  readonly type: 'Continue'
}

export interface Exit {
  readonly type: 'Exit'
  readonly value: Expr | null
}

export interface Return {
  readonly type: 'Return'
  readonly value: Expr | null
}

export interface Delete {
  readonly type: 'Delete'
  readonly name: string
  readonly subscripts: readonly Expr[] | null
}

export type Stmt =
  | Block
  | ExprStmt
  | Print
  | Printf
  | If
  | While
  | DoWhile
  | For
  | ForIn
  | Next
  | NextFile
  | Break
  | Continue
  | Exit
  | Return
  | Delete

export interface Rule {
  readonly kind: RuleKind
  readonly pattern: Expr | null
  readonly patternEnd: Expr | null
  readonly action: Block | null
}

export interface FuncDef {
  readonly name: string
  readonly params: readonly string[]
  readonly body: Block
}

export interface Program {
  readonly rules: readonly Rule[]
  readonly functions: ReadonlyMap<string, FuncDef>
}

export function isLvalue(node: Expr): node is Lvalue {
  return node.type === 'Var' || node.type === 'Field' || node.type === 'ArrayRef'
}
