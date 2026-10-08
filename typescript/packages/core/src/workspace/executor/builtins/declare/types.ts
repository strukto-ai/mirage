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

/**
 * A staged array literal, `NAME=(...)` or `NAME+=(...)`: the name, whether
 * it appends, and its expanded items. It travels as data so the builtin
 * that owns the keyword stores it through the session door.
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
