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

import type { TSNodeLike } from '../../shell/types.ts'

/**
 * Every command node of a parsed line, in source order, nested ones
 * included (a substitution's command follows the word holding it), and
 * every `[ ]` or `[[ ]]` test, the shell's own command.
 */
export function commandNodes(root: TSNodeLike): TSNodeLike[] {
  const nodes: TSNodeLike[] = []
  const stack: TSNodeLike[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    if (node.type === 'command' || node.type === 'test_command') nodes.push(node)
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i]
      if (child !== undefined) stack.push(child)
    }
  }
  return nodes
}
