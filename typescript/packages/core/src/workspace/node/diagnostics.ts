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

import { encodeText } from '../../shell/bytes.ts'
import { getText } from '../../shell/helpers.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { concat } from '../../utils/bytes.ts'
import type { EvaluationContext } from '../evaluation.ts'

/** The stderr a statement's expansions left, in the order they spoke: a
 * text diagnostic in bash's words, prefixed with the builtin the statement
 * names when bash names one, and bytes (a substitution's own stderr)
 * verbatim. Mirrors Python's diagnostic_stderr. */
export function diagnosticStderr(node: TSNodeLike, context: EvaluationContext): Uint8Array {
  const head = getText(node).trimStart().split(/\s+/, 1)[0] ?? ''
  const builtin = ['export', 'declare', 'local', 'readonly', 'read', 'printf', 'let'].includes(head)
    ? head
    : ''
  const prefix = builtin === '' ? 'bash: ' : `bash: ${builtin}: `
  return concat(
    context.frame.diagnostics.map((message) =>
      typeof message === 'string' ? encodeText(prefix + message + '\n') : message,
    ),
  )
}
