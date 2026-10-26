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

import { describe, expect, it } from 'vitest'
import { RAMVFS } from './ram.ts'
import { MountMode } from '../../types.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// Renders `.tally` reads, as a VFS that ships a renderer does.
class TallyRAMVFS extends RAMVFS {
  override readonly renderers: Readonly<Record<string, string>> = { '.tally': 'readTally' }

  readTally(): Promise<Uint8Array> {
    return Promise.resolve(ENC.encode('RENDERED'))
  }
}

describe('xxd -r into its own input', () => {
  it('reads back patched on a caching mount', async () => {
    // INFILE is OUTFILE on a caching mount: the cache must not keep the
    // write's marker as the file, so the next read sees the store. Mirrors
    // Python's test_xxd_reverse_into_its_own_input_reads_back_patched.
    const ram = new RAMVFS()
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ws = new Workspace({ '/data': ram }, { mode: MountMode.WRITE })
    try {
      await ws.shell("printf '00000000: 4142  AB\\n' > /data/d")
      await ws.shell('cat /data/d')
      const result = await ws.shell('xxd -r /data/d /data/d')
      expect(result.exitCode).toBe(0)
      expect(DEC.decode((await ws.shell('cat /data/d')).stdout)).toBe('AB000000: 4142  AB\n')
    } finally {
      await ws.close()
    }
  })
})

describe('xxd -r across mounts', () => {
  it('writes into the stored bytes of a rendered OUTFILE', async () => {
    // The OUTFILE's mount renders .tally reads; -r writes into what the
    // store holds, never into a rendering of it. Mirrors Python's
    // test_xxd_reverse_across_mounts_writes_into_the_stored_bytes.
    const source = new TallyRAMVFS()
    const target = new TallyRAMVFS()
    const ws = new Workspace({ '/a': source, '/b': target }, { mode: MountMode.WRITE })
    try {
      await ws.shell('printf ABCDEFGH > /b/out.tally')
      await ws.shell("printf '00000004: 6869  hi\\n' > /a/dump")
      const result = await ws.shell('xxd -r /a/dump /b/out.tally')
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(target.store.files.get('/out.tally'))).toBe('ABCDhiGH')
    } finally {
      await ws.close()
    }
  })
})
