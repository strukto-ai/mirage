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

import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
const RAM_SED = RAM_COMMANDS.filter((c) => c.name === 'sed' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runSed(
  resource: RAMResource,
  texts: string[],
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<string> {
  const cmd = RAM_SED[0]
  if (cmd === undefined) throw new Error('sed not registered')
  const result = await cmd.fn(
    (resource as { accessor?: unknown }).accessor as never,
    paths,
    texts,
    { stdin, flags, filetypeFns: null, cwd: '/', resource },
  )
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

describe('sed -f', () => {
  it('reads the script from a file', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/prog.sed', ENC.encode('s/hello/HI/\n'))
    resource.store.files.set('/tmp/in.txt', ENC.encode('hello world\n'))
    const out = await runSed(resource, [], [PathSpec.fromStrPath('/tmp/in.txt')], {
      f: ['/tmp/prog.sed'],
    })
    expect(out).toBe('HI world\n')
  })

  it('applies multiple commands from the script file', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/prog.sed', ENC.encode('s/hello/HI/\ns/world/EARTH/\n'))
    resource.store.files.set('/tmp/in.txt', ENC.encode('hello world\n'))
    const out = await runSed(resource, [], [PathSpec.fromStrPath('/tmp/in.txt')], {
      f: ['/tmp/prog.sed'],
    })
    expect(out).toBe('HI EARTH\n')
  })

  it('combines -e and -f (e then f)', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/prog.sed', ENC.encode('s/world/EARTH/\n'))
    resource.store.files.set('/tmp/in.txt', ENC.encode('hello world\n'))
    const out = await runSed(resource, [], [PathSpec.fromStrPath('/tmp/in.txt')], {
      e: 's/hello/HI/',
      f: ['/tmp/prog.sed'],
    })
    expect(out).toBe('HI EARTH\n')
  })

  it('reads the script file in stdin mode', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/prog.sed', ENC.encode('s/hello/HI/\n'))
    const out = await runSed(
      resource,
      [],
      [],
      { f: ['/tmp/prog.sed'] },
      ENC.encode('hello world\n'),
    )
    expect(out).toBe('HI world\n')
  })
})
