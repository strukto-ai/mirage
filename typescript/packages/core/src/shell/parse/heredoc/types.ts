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

/** One `<<` or `<<-` operator as the source spells it. */
export interface HeredocOperator {
  /** Offset of the delimiter word. */
  wordStart: number
  /** Offset just past the delimiter word. */
  wordEnd: number
  /** The delimiter as bash reads it, quotes removed. */
  delimiter: string
  /** Whether the operator was `<<-`. */
  allowsIndent: boolean
}

export interface Heredoc {
  operatorStart: number
  wordEnd: number
  delimiter: string
  quoted: boolean
  bodyStart: number
  end: number
  body: string
  offsets: number[]
  terminated: boolean
  line: number
  eofLine: number
}

/** The heredocs bash reads in a line, as its reader takes them: `order` is
 * each heredoc's `<<` and where its body starts and ends (past its
 * terminator), in the order bash reads the bodies; `closes` is each
 * substitution that closes with bodies still to read, its `)` and those
 * heredocs' `<<`, which bash warns of. */
export interface HeredocPlan {
  readonly order: readonly (readonly [number, number, number])[]
  readonly closes: readonly (readonly [number, readonly number[]])[]
}

export interface HeredocSource {
  original: string
  source: string
  offsets: number[]
  documents: [number, Heredoc][]
  closes: readonly (readonly [number, readonly number[]])[]
}

export interface BodyRead {
  body: string
  offsets: number[]
  end: number
  terminated: boolean
  eofLine: number
}
