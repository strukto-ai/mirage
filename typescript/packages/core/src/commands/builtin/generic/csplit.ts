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

import { stripSlash } from '../../../utils/slash.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function splitLinesNoTrailing(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

function splitByPatterns(lines: readonly string[], patterns: readonly string[]): string[][] {
  const parts: string[][] = []
  let currentStart = 0
  for (const pat of patterns) {
    if (pat.startsWith('/') && pat.endsWith('/')) {
      const regex = new RegExp(pat.slice(1, -1))
      for (let idx = currentStart; idx < lines.length; idx++) {
        if (regex.test(lines[idx] ?? '')) {
          parts.push(lines.slice(currentStart, idx))
          currentStart = idx
          break
        }
      }
    } else {
      const lineNum = Number.parseInt(pat, 10)
      const splitAt = lineNum - 1
      if (splitAt > currentStart) {
        parts.push(lines.slice(currentStart, splitAt))
        currentStart = splitAt
      }
    }
  }
  if (currentStart < lines.length) {
    parts.push(lines.slice(currentStart))
  }
  return parts
}

function padNum(n: number, digits: number): string {
  const s = String(n)
  return s.length >= digits ? s : '0'.repeat(digits - s.length) + s
}

function makePathSpec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: stripSlash(virtual),
    resolved: true,
  })
}

async function writePart(
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  filename: string,
  data: Uint8Array,
  writes: Record<string, Uint8Array>,
): Promise<void> {
  await write(makePathSpec(filename), data)
  writes[filename] = data
}

export async function csplitGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  const rawPrefix = typeof opts.flags.f === 'string' ? opts.flags.f : 'xx'
  const prefix = new PathSpec({
    virtual: rawPrefix,
    directory: rawPrefix,
    resourcePath: mountKey(rawPrefix, opts.mountPrefix ?? ''),
  }).mountPath
  const digits = typeof opts.flags.n === 'string' ? Number.parseInt(opts.flags.n, 10) : 2
  const quiet = opts.flags.s === true
  const keep = opts.flags.k === true
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
  const lines = splitLinesNoTrailing(text)
  const parts = splitByPatterns(lines, texts)
  const writes: Record<string, Uint8Array> = {}
  const sizes: string[] = []
  try {
    for (let idx = 0; idx < parts.length; idx++) {
      const part = parts[idx] ?? []
      const filename = prefix + padNum(idx, digits)
      const data = part.length > 0 ? ENC.encode(part.join('\n') + '\n') : new Uint8Array(0)
      await writePart(write, filename, data, writes)
      sizes.push(String(data.byteLength))
    }
  } catch (err) {
    if (!keep) {
      const msg = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`csplit: ${msg}\n`) })]
    }
  }
  const output = quiet || sizes.length === 0 ? '' : sizes.join('\n') + '\n'
  const result: ByteSource = ENC.encode(output)
  return [result, new IOResult({ writes })]
}
