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
const RAM_MKTEMP = RAM_COMMANDS.filter((c) => c.name === 'mktemp' && c.filetype == null)

const DEC = new TextDecoder()

async function runMktemp(
  flags: Record<string, string | boolean | string[]>,
  texts: string[] = [],
): Promise<{ out: string; resource: RAMResource }> {
  const resource = new RAMResource()
  const cmd = RAM_MKTEMP[0]
  if (cmd === undefined) throw new Error('mktemp not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { out: '', resource }
  const [out] = result
  if (out === null) return { out: '', resource }
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), resource }
}

describe('mktemp', () => {
  it('creates a temp file under /tmp', async () => {
    const { out, resource } = await runMktemp({})
    const path = out.trim()
    expect(path.startsWith('/tmp/')).toBe(true)
    expect(resource.store.files.has(path)).toBe(true)
  })

  it('-d creates a temp directory under /tmp', async () => {
    const { out, resource } = await runMktemp({ d: true })
    const path = out.trim()
    expect(path.startsWith('/tmp/')).toBe(true)
    expect(resource.store.dirs.has(path)).toBe(true)
  })
})
