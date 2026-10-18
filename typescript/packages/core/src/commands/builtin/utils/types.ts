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

export type AsyncReaddirFn = (path: string) => Promise<string[]>

/**
 * A pattern translated from its dialect into this host's. `ignoreCase` says
 * the host engine must fold case itself: a translator folds each literal and
 * class in the source when case sensitivity changes inside the pattern, and
 * leaves it to the host when the whole pattern is caseless, which keeps the
 * source plain enough for the grep prefilter to read.
 */
export interface HostRegex {
  readonly source: string
  readonly ignoreCase: boolean
  // The pattern holds a literal newline, or a class of nothing else, which
  // ripgrep refuses outside multiline mode.
  readonly newline?: boolean
}
