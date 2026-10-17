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

import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { readStdinAsync, stdinStream } from '../utils/stream.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'
import { compareCodePoints } from '../../../utils/sort.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

// One node, GNU tsort's `struct item`: predecessors not yet printed, the
// successors oldest relation first (GNU links them newest first, so every walk
// runs from the end), and the link a loop trace follows.
// Mirrors Python's _Item.
interface Item {
  readonly name: string
  count: number
  readonly successors: Item[]
  qlink: Item | null
  printed: boolean
}

// Trace one loop as GNU's `detect_loop` does and drop one relation; returns
// the loop's members in the order GNU reports them. Mirrors Python's
// _break_loop.
function breakLoop(tree: readonly Item[]): string[] {
  let loop: Item | null = null
  for (;;) {
    for (const k of tree) {
      if (k.count <= 0) continue
      if (loop === null) {
        loop = k
        continue
      }
      for (let index = k.successors.length - 1; index >= 0; index--) {
        const successor = k.successors[index]
        if (successor !== loop) continue
        if (k.qlink === null) {
          k.qlink = loop
          loop = k
          break
        }
        const members: string[] = []
        let node: Item | null = loop
        while (node !== null) {
          members.push(node.name)
          const after: Item | null = node.qlink
          if (node === k) {
            successor.count -= 1
            k.successors.splice(index, 1)
            break
          }
          node.qlink = null
          node = after
        }
        while (node !== null) {
          const after: Item | null = node.qlink
          node.qlink = null
          node = after
        }
        return members
      }
    }
  }
}

// GNU tsort's order, and every loop it had to break on the way. Mirrors
// Python's _topological_sort.
function topologicalSort(pairs: readonly (readonly [string, string])[]): [string[], string[][]] {
  const items = new Map<string, Item>()
  const itemOf = (name: string): Item => {
    let found = items.get(name)
    if (found === undefined) {
      found = { name, count: 0, successors: [], qlink: null, printed: false }
      items.set(name, found)
    }
    return found
  }
  for (const [a, b] of pairs) {
    const j = itemOf(a)
    const k = itemOf(b)
    if (a !== b) {
      k.count += 1
      j.successors.push(k)
    }
  }
  const tree = [...items.keys()].sort(compareCodePoints).map((name) => itemOf(name))
  const order: string[] = []
  const loops: string[][] = []
  let remaining = tree.length
  while (remaining > 0) {
    const queue = tree.filter((k) => k.count === 0 && !k.printed)
    for (const head of queue) {
      order.push(head.name)
      head.printed = true
      remaining -= 1
      for (let index = head.successors.length - 1; index >= 0; index--) {
        const successor = head.successors[index]
        if (successor === undefined) continue
        successor.count -= 1
        if (successor.count === 0) queue.push(successor)
      }
    }
    if (remaining > 0) loops.push(breakLoop(tree))
  }
  return [order, loops]
}

export async function tsortGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, ctx.stdin)
  if (paths.length > 1) throw extraOperandError(CommandName.TSORT, paths[1]?.rawPath ?? '')
  let raw: Uint8Array
  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    raw = await materialize(stream(first))
  } else {
    const stdinData = await readStdinAsync(ctx.stdin)
    raw = stdinData ?? new Uint8Array(0)
  }
  const text = DEC.decode(raw)
  const tokens = text.split(/\s+/).filter((s) => s !== '')
  if (tokens.length % 2 !== 0) {
    const name = paths[0]?.rawPath ?? '-'
    const msg = `tsort: ${name}: input contains an odd number of tokens\n`
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(msg) })]
  }
  const pairs: [string, string][] = []
  for (let i = 0; i < tokens.length; i += 2) {
    pairs.push([tokens[i] ?? '', tokens[i + 1] ?? ''])
  }
  const [order, loops] = topologicalSort(pairs)
  const result: ByteSource = ENC.encode(order.map((name) => `${name}\n`).join(''))
  if (loops.length === 0) return [result, new IOResult()]
  const name = paths[0]?.rawPath ?? '-'
  const report = loops
    .map(
      (members) =>
        `tsort: ${name}: input contains a loop:\n` +
        members.map((member) => `tsort: ${member}\n`).join(''),
    )
    .join('')
  return [result, new IOResult({ exitCode: 1, stderr: ENC.encode(report) })]
}
