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

const trees = new WeakMap<ShellNode, Tree>()

export function treeOf(node: ShellNode): Tree {
  const tree = node instanceof Node ? node.tree : trees.get(node)
  if (tree === undefined) throw new Error('shell node has no owning tree')
  return tree
}

export function linkTree(wrapper: ShellNode, node: ShellNode): void {
  trees.set(wrapper, treeOf(node))
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
