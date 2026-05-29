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

import type { SlackAccessor } from '../../../accessor/slack.ts'
import { resolveSlackGlob } from '../../../core/slack/glob.ts'
import { read as slackRead } from '../../../core/slack/read.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { fileReadProvision } from './_provision.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function numberLines(data: Uint8Array): Uint8Array {
  const text = DEC.decode(data)
  const lines = text.split('\n')
  const trailing = text.endsWith('\n')
  const limit = trailing ? lines.length - 1 : lines.length
  const out: string[] = []
  for (let i = 0; i < limit; i++) {
    out.push(`     ${String(i + 1)}\t${lines[i] ?? ''}\n`)
  }
  return ENC.encode(out.join(''))
}

function concatBuffers(buffers: readonly Uint8Array[]): Uint8Array {
  if (buffers.length === 0) return new Uint8Array(0)
  if (buffers.length === 1) return buffers[0] ?? new Uint8Array(0)
  let total = 0
  for (const b of buffers) total += b.length
  const out = new Uint8Array(total)
  let off = 0
  for (const b of buffers) {
    out.set(b, off)
    off += b.length
  }
  return out
}

async function catCommand(
  accessor: SlackAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const nFlag = opts.flags.n === true
  if (paths.length > 0) {
    const resolved = await resolveSlackGlob(accessor, paths, opts.index ?? undefined)
    if (resolved.length === 0) return [null, new IOResult()]
    const reads: Record<string, Uint8Array> = {}
    const cache: string[] = []
    const buffers: Uint8Array[] = []
    for (const p of resolved) {
      const data = await slackRead(accessor, p, opts.index ?? undefined)
      reads[p.stripPrefix] = data
      cache.push(p.stripPrefix)
      buffers.push(data)
    }
    const merged = concatBuffers(buffers)
    const out: ByteSource = nFlag ? numberLines(merged) : merged
    return [out, new IOResult({ reads, cache })]
  }
  const raw = await readStdinAsync(opts.stdin)
  if (raw === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('cat: missing operand\n') })]
  }
  const out: ByteSource = nFlag ? numberLines(raw) : raw
  return [out, new IOResult()]
}

export const SLACK_CAT = command({
  name: 'cat',
  resource: ResourceName.SLACK,
  spec: specOf('cat'),
  fn: catCommand,
  provision: fileReadProvision,
})
