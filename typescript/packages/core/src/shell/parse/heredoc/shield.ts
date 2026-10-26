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

import type { TSNodeLike } from '../../types.ts'
import { DASH_ARROW, HEREDOC_START } from './constants.ts'
import { cleanDelimiter } from './delimiter.ts'
import type { HeredocOperator } from './types.ts'
import { walkTree } from '../names.ts'

/**
 * Every heredoc operator under `root`, in source order.
 *
 * These are hints; the source reader validates delimiter word bounds.
 */
export function heredocOperators(root: TSNodeLike): HeredocOperator[] {
  const found: HeredocOperator[] = []
  for (const node of walkTree(root)) {
    if (node.type !== HEREDOC_START) continue
    if (node.startIndex === undefined || node.endIndex === undefined) continue
    const delimiter = cleanDelimiter(node.text)
    found.push({
      wordStart: node.startIndex,
      wordEnd: node.endIndex,
      delimiter,
      allowsIndent: node.previousSibling?.type === DASH_ARROW,
    })
  }
  return found.sort((a, b) => a.wordStart - b.wordStart)
}
