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

// GNU 9.7's order, measured on 10,000 random inputs: the names nothing has
// to precede go first, in byte order, then each name as soon as every name
// that must precede it is out, a name's own followers taken newest pair
// first. When every name left still waits on another, one loop is reported
// and cut: stepping back from the smallest name left, each step takes the
// name before it that sorts next after it (wrapping round to the smallest),
// and the first name met twice closes the loop. The loop is listed from the
// last step forward and the pair that closed it is dropped, which may free
// the first name listed; if it does not, the next loop is found the same way.

function closingLoop(start: string, leaders: ReadonlyMap<string, Map<string, number>>): string[] {
  const trail: string[] = []
  const met = new Map<string, number>()
  let here = start
  for (;;) {
    const before = [...(leaders.get(here)?.keys() ?? [])].sort(compareCodePoints)
    const step = before.find((name) => compareCodePoints(name, here) > 0) ?? before[0] ?? here
    const at = met.get(step)
    if (at !== undefined) return trail.slice(at).reverse()
    met.set(step, trail.length)
    trail.push(step)
    here = step
  }
}

function orderWithLoops(pairs: readonly (readonly [string, string])[]): [string[], string[][]] {
  const names = [...new Set(pairs.flat())].sort(compareCodePoints)
  const followers = new Map<string, string[]>(names.map((name) => [name, []]))
  const leaders = new Map<string, Map<string, number>>(names.map((name) => [name, new Map()]))
  const waiting = new Map<string, number>(names.map((name) => [name, 0]))
  for (const [first, then] of pairs) {
    if (first === then) continue
    followers.get(first)?.push(then)
    const before = leaders.get(then)
    before?.set(first, (before.get(first) ?? 0) + 1)
    waiting.set(then, (waiting.get(then) ?? 0) + 1)
  }
  const ready = names.filter((name) => waiting.get(name) === 0)
  const placed = new Set<string>()
  const order: string[] = []
  const loops: string[][] = []
  let next = 0
  let lowest = 0
  const release = (first: string, then: string): void => {
    const before = leaders.get(then)
    const count = (before?.get(first) ?? 0) - 1
    if (count > 0) before?.set(first, count)
    else before?.delete(first)
    const left = (waiting.get(then) ?? 0) - 1
    waiting.set(then, left)
    if (left === 0) ready.push(then)
  }
  for (;;) {
    for (; next < ready.length; next += 1) {
      const name = ready[next] ?? ''
      order.push(name)
      placed.add(name)
      const after = followers.get(name) ?? []
      for (let i = after.length - 1; i >= 0; i -= 1) {
        const then = after[i] ?? ''
        if (leaders.get(then)?.has(name) === true) release(name, then)
      }
    }
    while (lowest < names.length && placed.has(names[lowest] ?? '')) lowest += 1
    const start = names[lowest]
    if (start === undefined) return [order, loops]
    const loop = closingLoop(start, leaders)
    loops.push(loop)
    release(loop[loop.length - 1] ?? '', loop[0] ?? '')
  }
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
  const [order, loops] = orderWithLoops(pairs)
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
