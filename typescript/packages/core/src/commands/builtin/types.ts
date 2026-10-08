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

/** One `-exec` action: the words between `-exec` and its terminator, `{}`
 * still in place, and whether it is `{} +` (one run over every match)
 * rather than `;` (one run per match). */
import type { RowActionKind } from '../../core/generic/find_eval.ts'

export interface ExecAction {
  readonly kind: 'exec'
  readonly argv: readonly string[]
  readonly batch: boolean
}

/** One of find's row actions, in the position it was written. */
export interface RowAction {
  readonly kind: RowActionKind
}

/** One `-printf` action: each row it reaches, rendered through `format`,
 * the format as typed, escapes and directives unexpanded. */
export interface PrintfAction {
  readonly kind: 'printf'
  readonly format: string
}

export type FindAction = ExecAction | RowAction | PrintfAction

/**
 * The regex dialect a search pattern is written in. One translator per
 * dialect turns it into host source: `BASIC` and `EXTENDED` are glibc's
 * (grep's default and -E), `PERL` is PCRE2's (grep -P, rg -P) and `RUST` is
 * ripgrep's default engine. The value is also the spelling a pushed-down
 * search carries. Mirrors `RegexSyntax` in `types.py`.
 */
export enum RegexSyntax {
  BASIC = 'basic',
  EXTENDED = 'extended',
  PERL = 'perl',
  RUST = 'rust',
}

/** Parsed per-request options owned by the grep integration. */
export interface GrepSearchOptions {
  readonly ignoreCase: boolean
  readonly fixedString: boolean
  readonly wholeWord: boolean
  readonly syntax: RegexSyntax
  /** grep runs under a UTF-8 locale, so a line is matched as text rather than as its bytes. */
  readonly utf8: boolean
}

/** Declared search dialect and fallback scan strategy for grep/rg. */
export interface GrepSearchMeta {
  readonly mode: 'literal' | 'regex'
  readonly stream: boolean
}
