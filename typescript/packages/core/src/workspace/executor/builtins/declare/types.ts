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

import type { VarAttr, VarKind } from '../../../../shell/variable.ts'

/**
 * A staged array literal, `NAME=(...)` or `NAME+=(...)`: the name, whether
 * it appends, and its expanded items. It travels as data so the builtin
 * that owns the keyword stores it through the session view.
 */
export interface StagedArray {
  name: string
  append: boolean
  items: string[]
}

/**
 * One declaration operand in the order it was typed: a word (`NAME`,
 * `NAME=value`, an option) or a staged array literal.
 */
export type DeclarationOperand = string | StagedArray

/**
 * The attribute letters a declaration applies, in order: each attribute and
 * whether it goes on (`-x`) or off (`+x`).
 */
export type AttrMarks = readonly (readonly [VarAttr, boolean])[]

/**
 * How a `local`, `declare` or `typeset` runs its operands. `cmd` is the
 * spelling that reached here: `declare` and `typeset` route through
 * `handleLocal` and must say their own name, not `local`. `kind` is the kind
 * `-a` / `-A` declared, so staged literals build that kind of array.
 * `shaping` holds the value-shaping marks (`-i -l -u`, `+i +l +u`), put on or
 * taken off each name *before* its value stores so the declaration's own
 * value coerces exactly as a later write would (`declare +i N+=x` over an
 * integer 5 stores `5x`); `marks` the attribute letters put on or taken off
 * each operand once it lands, readonly last; `plus` the `+` letters, for the
 * two that cannot be taken off (`plusRefusal`). `nameref` (`-n`) stores a
 * value on the reference's own record, which also takes the marks; under
 * `globalScope` (`-g`) a name the function shadows has its *global* record
 * read, written and marked (`reachGlobal`); `inherit` (`-I`) starts a new
 * local from the value it shadows (`startLocal`).
 */
export interface Declaration {
  cmd: string
  kind: VarKind | null
  shaping: AttrMarks
  marks: AttrMarks
  plus: string
  nameref: boolean
  globalScope: boolean
  inherit: boolean
}
