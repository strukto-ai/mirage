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

import { RAM_COMMANDS } from '../index.ts'
import { describe, expect, it } from 'vitest'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { grep as parquetGrep } from '../../../../core/filetype/parquet.ts'
import { materialize } from '../../../../io/types.ts'
import { RAMResource } from '../../../../resource/ram/ram.ts'
import { PathSpec } from '../../../../types.ts'
const RAM_GREP = RAM_COMMANDS.filter((c) => c.name === 'grep' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runGrep(
  resource: RAMResource,
  pattern: string,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<{ text: string; exitCode: number }> {
  const cmd = RAM_GREP[0]
  if (cmd === undefined) throw new Error('grep not registered')
  const result = await cmd.fn(resource.accessor, paths, [pattern], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { text: '', exitCode: 0 }
  const [out, io] = result
  if (out === null) return { text: '', exitCode: io.exitCode }
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return { text: DEC.decode(buf), exitCode: io.exitCode }
}

describe('grep recursive filetype', () => {
  it('grep across multiple plain-text files finds matching lines', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/a.txt', ENC.encode('alice likes cats\nbob likes dogs\n'))
    resource.store.files.set('/b.txt', ENC.encode('alice again\n'))
    const { text } = await runGrep(resource, 'alice', [
      PathSpec.fromStrPath('/a.txt'),
      PathSpec.fromStrPath('/b.txt'),
    ])
    expect(text).toContain('alice')
    expect(text).toContain('/a.txt')
    expect(text).toContain('/b.txt')
  })

  it('no match across plain-text files returns exitCode 1', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/a.txt', ENC.encode('alice\n'))
    resource.store.files.set('/b.txt', ENC.encode('bob\n'))
    const { text, exitCode } = await runGrep(resource, 'nonexistent', [
      PathSpec.fromStrPath('/a.txt'),
      PathSpec.fromStrPath('/b.txt'),
    ])
    expect(text.trim()).toBe('')
    expect(exitCode).toBe(1)
  })

  it('grep -r walks a directory and finds matches across files', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/data')
    resource.store.dirs.add('/data/sub')
    resource.store.files.set('/data/a.txt', ENC.encode('alice\nbob\n'))
    resource.store.files.set('/data/sub/b.txt', ENC.encode('carol\nalice again\n'))
    const { text, exitCode } = await runGrep(resource, 'alice', [PathSpec.fromStrPath('/data')], {
      r: true,
    })
    expect(exitCode).toBe(0)
    const lines = text.trim().split('\n').sort()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('a.txt')
    expect(lines[1]).toContain('b.txt')
  })

  it('parquet filetype grep helper finds rows matching a pattern', async () => {
    const ab = parquetWriteBuffer({
      columnData: [{ name: 'name', data: ['alice', 'bob', 'alicia'], type: 'STRING' }],
    })
    const out = await parquetGrep(new Uint8Array(ab), 'alic')
    const text = DEC.decode(out)
    expect(text).toContain('alice')
    expect(text).toContain('alicia')
    expect(text).not.toContain('bob')
  })
})
