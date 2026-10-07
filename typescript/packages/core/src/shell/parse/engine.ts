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

import { Node, type Parser, type Tree } from 'web-tree-sitter'
import type { ShellNode } from '../types.ts'

export type NativeParser = Pick<Parser, 'parse'>

/** A node that reads another node of the same tree. */
export interface WrappedNode extends ShellNode {
  readonly inner: ShellNode
}

/** The native tree under a node, found through its wrappers when asked. */
export function treeOf(node: ShellNode): Tree {
  let at: ShellNode = node
  while (!(at instanceof Node)) {
    if (!('inner' in at)) throw new Error('shell node has no owning tree')
    at = (at as WrappedNode).inner
  }
  return at.tree
}

/** All native allocations of one synchronous parse, including recovery. */
export class ParseTrees implements NativeParser {
  private readonly trees = new Set<Tree>()
  constructor(private readonly parser: NativeParser) {}

  parse(...args: Parameters<Parser['parse']>): ReturnType<Parser['parse']> {
    const tree = this.parser.parse(...args)
    if (tree !== null) this.trees.add(tree)
    return tree
  }

  take(root: ShellNode): Tree {
    const tree = treeOf(root)
    if (!this.trees.delete(tree)) throw new Error('tree belongs to another parse')
    return tree
  }

  release(): void {
    for (const tree of this.trees) tree.delete()
    this.trees.clear()
  }
}
