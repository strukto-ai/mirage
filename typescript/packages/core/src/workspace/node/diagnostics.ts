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
import type { EvaluationContext } from '../evaluation.ts'

export function diagnosticStderr(node: TSNodeLike, context: EvaluationContext): Uint8Array {
  const head = getText(node).trimStart().split(/\s+/, 1)[0] ?? ''
  const builtin = ['export', 'declare', 'local', 'readonly', 'read', 'printf', 'let'].includes(head)
    ? head
    : ''
  const prefix = builtin === '' ? 'bash: ' : `bash: ${builtin}: `
  const parts = context.frame.diagnostics.map((message) =>
    typeof message === 'string' ? encodeText(prefix + message + '\n') : message,
  )
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}
