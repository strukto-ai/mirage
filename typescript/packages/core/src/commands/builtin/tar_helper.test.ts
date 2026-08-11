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
import { readTar, writeTar, type TarEntry } from './tar_helper.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

describe('tar_helper', () => {
  it('round-trips a name past the 100 byte ustar limit', async () => {
    // ustar stores a name in 100 bytes; anything longer needs the prefix
    // field or a PAX header. Truncating it silently used to write the
    // member under a shortened path, so extraction landed on the wrong one.
    const name = `deep/${'x'.repeat(120)}/b.txt`
    const entries = await readTar(
      await writeTar([{ name, data: ENC.encode('bbb\n'), isFile: true }]),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe(name)
    expect(DEC.decode(entries[0]?.data)).toBe('bbb\n')
  })

  it('reports no member for the extended header a long name needs', async () => {
    // A PAX header is a block with its own typeflag, not a member. Reading
    // it as one used to add a phantom `././@PaxHeader` row to `tar -t`.
    const entries = await readTar(
      await writeTar([
        { name: 'a.txt', data: ENC.encode('aaa\n'), isFile: true },
        { name: `${'y'.repeat(150)}.txt`, data: ENC.encode('yyy\n'), isFile: true },
      ]),
    )
    expect(entries.map((e) => e.name)).toEqual(['a.txt', `${'y'.repeat(150)}.txt`])
  })

  it('round-trips a directory member as content-free with a trailing slash', async () => {
    const entries = await readTar(
      await writeTar([{ name: 'folder', data: new Uint8Array(0), isFile: false, isDir: true }]),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('folder/')
    expect(entries[0]?.isDir).toBe(true)
    expect(entries[0]?.isFile).toBe(false)
    expect(entries[0]?.data.byteLength).toBe(0)
  })

  it('round-trips a symlink member as its target, not its target bytes', async () => {
    const entries: TarEntry[] = [
      { name: 'link', data: ENC.encode('ignored'), isFile: false, linkname: '../target' },
    ]
    const back = await readTar(await writeTar(entries))
    expect(back).toHaveLength(1)
    expect(back[0]?.linkname).toBe('../target')
    expect(back[0]?.isFile).toBe(false)
    expect(back[0]?.data.byteLength).toBe(0)
  })
})
