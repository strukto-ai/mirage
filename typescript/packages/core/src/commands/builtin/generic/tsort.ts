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
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function getOrCreate(
  graph: Map<string, Set<string>>,
  inDegree: Map<string, number>,
  node: string,
): Set<string> {
  const existing = graph.get(node)
  if (existing !== undefined) return existing
  const created = new Set<string>()
  graph.set(node, created)
  inDegree.set(node, 0)
  return created
}

function topologicalSort(pairs: readonly (readonly [string, string])[]): [string[], boolean] {
  const graph = new Map<string, Set<string>>()
  const inDegree = new Map<string, number>()
  for (const [a, b] of pairs) {
    const adj = getOrCreate(graph, inDegree, a)
    getOrCreate(graph, inDegree, b)
    if (!adj.has(b)) {
      adj.add(b)
      inDegree.set(b, (inDegree.get(b) ?? 0) + 1)
    }
  }
  const queue: string[] = []
  for (const [node, deg] of inDegree) {
    if (deg === 0) queue.push(node)
  }
  const result: string[] = []
  let head = 0
  while (head < queue.length) {
    const node = queue[head] ?? ''
    head += 1
    result.push(node)
    const neighbors = [...(graph.get(node) ?? new Set<string>())].sort()
    for (const nb of neighbors) {
      const d = (inDegree.get(nb) ?? 0) - 1
      inDegree.set(nb, d)
      if (d === 0) queue.push(nb)
    }
  }
  const hasCycle = result.length !== graph.size
  return [result, hasCycle]
}

export async function tsortGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  if (paths.length > 1) throw extraOperandError(CommandName.TSORT, paths[1]?.rawPath ?? '')
  let raw: Uint8Array
  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    raw = await materialize(stream(first))
  } else {
    const stdinData = await readStdinAsync(opts.stdin)
    raw = stdinData ?? new Uint8Array(0)
  }
  const text = DEC.decode(raw)
  const tokens = text.split(/\s+/).filter((s) => s !== '')
  if (tokens.length % 2 !== 0) {
    const out: ByteSource = ENC.encode('tsort: odd number of tokens\n')
    return [out, new IOResult({ exitCode: 1 })]
  }
  const pairs: [string, string][] = []
  for (let i = 0; i < tokens.length; i += 2) {
    pairs.push([tokens[i] ?? '', tokens[i + 1] ?? ''])
  }
  const [sorted, hasCycle] = topologicalSort(pairs)
  if (hasCycle) {
    const out: ByteSource = ENC.encode('tsort: cycle detected\n')
    return [out, new IOResult({ exitCode: 1 })]
  }
  const result: ByteSource = ENC.encode(sorted.length > 0 ? sorted.join('\n') + '\n' : '')
  return [result, new IOResult()]
}
