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

/** What a line's syntax check refuses, in bash's words: the text bash names
 * (empty at the end of input), the diagnostic lines, and the status. Mirrors
 * Python's SyntaxDiagnostic. */
export interface SyntaxDiagnostic {
  readonly offending: string
  readonly message: string
  readonly status: number
}

/** One token the line reader read: what it is (`word`, `op`, `newline`, ...),
 * its text, where it starts and ends, whether it is a word read literally (no
 * quote, escape, substitution, subscript or array in it) and whether it spells
 * an assignment (a name then `=`). Mirrors Python's ReaderToken. */
export interface ReaderToken {
  readonly kind: string
  readonly text: string
  readonly start: number
  readonly end: number
  readonly plain: boolean
  readonly assign: boolean
}

/** A heredoc the reader owes a body for: where its `<<` stands, the word that
 * ends the body (quotes removed), whether it is `<<-` (leading tabs stripped)
 * and whether the delimiter was quoted (a literal body). Mirrors Python's
 * ReaderHeredoc. */
export interface ReaderHeredoc {
  readonly at: number
  readonly delimiter: string
  readonly strip: boolean
  readonly quoted: boolean
}

/** Where the line reader stands, to return to after a lookahead: its offset,
 * the token it peeked (where, in which mode), the heredocs it owes, how many
 * of those came out of a substitution, and whether the command before was
 * compound, so the next token reads as one where a command starts. Mirrors
 * Python's ReaderState. */
export type ReaderState = readonly [
  number,
  readonly [number, number, ReaderToken] | null,
  readonly ReaderHeredoc[],
  number,
  boolean,
]
