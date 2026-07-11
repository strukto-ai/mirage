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

export const AwkCmpOp = {
  EQ: '==',
  NE: '!=',
  GT: '>',
  LT: '<',
  GE: '>=',
  LE: '<=',
} as const
export type AwkCmpOp = (typeof AwkCmpOp)[keyof typeof AwkCmpOp]

export const AwkBoolOp = {
  AND: '&&',
  OR: '||',
} as const
export type AwkBoolOp = (typeof AwkBoolOp)[keyof typeof AwkBoolOp]

export const AwkBlock = {
  BEGIN: 'BEGIN',
  END: 'END',
} as const
export type AwkBlock = (typeof AwkBlock)[keyof typeof AwkBlock]

export const AwkBuiltin = {
  NR: 'NR',
  NF: 'NF',
  REC: '$0',
} as const
export type AwkBuiltin = (typeof AwkBuiltin)[keyof typeof AwkBuiltin]

export const FIELD_PREFIX = '$'
export const PRINT_STMT = 'print'
export const CMP_OP_PATTERN = /==|!=|>=|<=|>|</

export const USAGE = "awk: usage: awk [-F fs] [-v var=val] 'program' [file ...]"

export interface AwkFlags {
  readonly fieldSeparator: string | null
  readonly assignments: readonly string[]
  readonly programFiles: readonly string[]
}
