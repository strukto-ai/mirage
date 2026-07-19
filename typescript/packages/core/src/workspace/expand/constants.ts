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

import { NodeType as NT } from '../../shell/types.ts'

// Sentinels delimiting an inert atom in a brace-expansion template: an
// already-expanded chunk that never contributes brace metacharacters,
// matching bash's ordering where brace expansion runs before parameter
// and command substitution. Shell input cannot contain NUL, so the
// sentinels cannot collide with template text.
export const INERT_OPEN = '\u0000'
export const INERT_CLOSE = '\u0001'

// GNU sequence-expression grammar for `{x..y[..step]}`: numeric
// endpoints (optionally signed), or single alphabetic characters.
export const NUM_SEQ = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/
export const CHAR_SEQ = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/

// Unquoted expansions whose result splits into words on whitespace.
export const SPLIT_TYPES: ReadonlySet<string> = new Set([NT.SIMPLE_EXPANSION, NT.EXPANSION])

// Node types that may carry a brace-expandable word.
export const BRACE_WORD_TYPES: ReadonlySet<string> = new Set([
  NT.CONCATENATION,
  NT.BRACE_EXPRESSION,
])

// Children of a brace word whose raw text joins the template as
// literal, brace-eligible text; everything else expands first and
// joins as an inert atom.
export const BRACE_LITERAL_TYPES: ReadonlySet<string> = new Set([
  NT.WORD,
  NT.NUMBER,
  NT.BRACE_EXPRESSION,
])

// Arithmetic operator tokens from tree-sitter that pass through as-is
// when the expression text is reconstructed for the shared evaluator
// (shell/arith.ts).
export const ARITH_OPERATORS: ReadonlySet<string> = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  '<<',
  '>>',
  '&',
  '|',
  '^',
  '~',
  '&&',
  '||',
  '!',
  '?',
  ':',
  '(',
  ')',
  ',',
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '<<=',
  '>>=',
  '&=',
  '^=',
  '|=',
  '++',
  '--',
])

// Arithmetic delimiter tokens that mark the start/end of $((...)) and
// the (( ... )) arithmetic command.
export const ARITH_DELIMITERS: ReadonlySet<string> = new Set(['$((', '((', '))'])
