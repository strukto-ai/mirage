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
import { ByteSpool } from '../../io/spool.ts'
import { gunzip } from '../../utils/compress.ts'
import { readTar, readTarSpool, writeTar, type TarEntry } from './tar_helper.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// GNU tar 1.35 (debian:stable-slim), `tar --format=<format> --mtime=@0
// --owner=0 --group=0 --numeric-owner -cf - dir$'\377' ln$'\377'` piped
// through `gzip -n -9 | base64 -w0`: a directory dir\377 holding a
// 120-character directory and its file f\377, and a symlink ln\377 ->
// tgt\377. gnu stores the long names as GNU long-name members, posix as pax
// records, and ustar refuses the long one and keeps the rest.
const NON_UTF8 = {
  gnu: 'H4sIAAAAAAACA+3XQQ6CMBCF4a49RU9ASwPM1gNwCRMiIRpMEDdeHgsbAlEji2pi/29B2b/M67RqusGosKwneT6d3vp88i+2cErn6gtu1/7Qaa0ilZjE7MtLW5dNewqYf5FlL/NPRZb5p9OhS/IPrhrn3/6IUYgk/0397/yX/o+m/51N1/e/FBn9///9fxxo4Djyfzf/Y9kv9z8R8fNvmf/g7jtmIGbnNnwFT/vf/Mb75P0/rova9XU/MP8AAAAAAAAAAGz2ANbu+mQAKAAA',
  posix:
    'H4sIAAAAAAACA+2YwU7DMBBEfeYr/AXJ7tqx20PvHPsLEQ1QCRBKXani51MnIBQSURVBXCDzLrbigw+TmZE3y9fl4boqN1W9yzfbulE/D0Wctd0aGa7ELO/77juzMaT0QSVgvwtlHa9X84Stfi7D/aqVPr8ypMuwfaxW7JciZERcRguyzkcF29Ob0alfvp0q8AfpdJ/4jtbUvig+9f9471lE6QL+T6N/rwJoIk7lvyH7UX9hjr8L8j9F/hvXKwC6EGiei/o/gcJfyn8hssj/f6X/6fx3Q/25MMj/NPm/+A35f9ugAWbrfyIZ5b+xShP8Pzkv8M6syfqPv4enKcZ/Z8z/aDj/Y8fo/yT9L6/1H6VHA8+QiSw/nv95f/77j2MmFEpLuAsN/A8AAAAAAAAAAHybIxhoodwAKAAA',
  ustar:
    'H4sIAAAAAAACA+3RMQoCMRQE0H+UvYFJIOQ8giCCWKzx/DFsKVvYrI3vNTPdFHO5reMUx0pTq3XL6TN3esulxFLjB17Pfl7nZPyn+2McvrH939r3/+eUco2l9Gsf/gcAAAAAAAAAANj1BstWnRgAKAAA',
}
const DEEP = `dir\udcff/${'0'.repeat(120)}/`

describe('tar_helper', () => {
  it('reads a raw header whose checksum ends with NUL then newline', async () => {
    const archive = new Uint8Array(2048)
    archive.set(ENC.encode('a.txt'), 0)
    archive.set(ENC.encode('0000644\0'), 100)
    archive.set(ENC.encode('0000000\0'), 108)
    archive.set(ENC.encode('0000000\0'), 116)
    archive.set(ENC.encode('00000000006\0'), 124)
    archive.set(ENC.encode('00000000000\0'), 136)
    archive.fill(32, 148, 156)
    archive.set(ENC.encode('0'), 156)
    archive.set(ENC.encode('ustar\0'), 257)
    archive.set(ENC.encode('00'), 263)
    const checksum = archive.subarray(0, 512).reduce((sum, byte) => sum + byte, 0)
    archive.set(ENC.encode(`${checksum.toString(8).padStart(6, '0')}\0\n`), 148)
    archive.set(ENC.encode('hello\n'), 512)

    const entries = await readTar(archive)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('a.txt')
    expect(entries[0]?.isFile).toBe(true)
    expect(DEC.decode(entries[0]?.data)).toBe('hello\n')
  })

  it('accepts a complete member without EOF padding and ignores data after EOF', async () => {
    const archive = await writeTar([{ name: 'a.txt', data: ENC.encode('aaa\n'), isFile: true }])
    const withTail = new Uint8Array(archive.length + 4)
    withTail.set(archive)
    withTail.set(ENC.encode('junk'), archive.length)
    for (const bytes of [archive.subarray(0, 1024), archive.subarray(0, 1536), withTail]) {
      const entries = await readTar(bytes)
      expect(entries.map((entry) => entry.name)).toEqual(['a.txt'])
      expect(DEC.decode(entries[0]?.data)).toBe('aaa\n')
    }
    expect(await readTar(new Uint8Array(512))).toEqual([])
  })

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

  it.each(Object.entries(NON_UTF8))(
    'keeps a name byte that is not UTF-8 in a %s archive as its sentinel',
    async (format, encoded) => {
      const source = new ByteSpool()
      const contents = new ByteSpool()
      try {
        await source.append(await gunzip(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))))
        const entries = await readTarSpool(source, contents)
        const expected =
          format === 'ustar'
            ? ['dir\udcff/', 'ln\udcff']
            : ['dir\udcff/', DEEP, `${DEEP}f\udcff`, 'ln\udcff']
        expect(entries.map((entry) => entry.name)).toEqual(expected)
        expect(entries.at(-1)?.linkname).toBe('tgt\udcff')
        expect(DEC.decode(await contents.read(0, contents.size))).toBe(
          format === 'ustar' ? '' : 'z\n',
        )
      } finally {
        await source.close()
        await contents.close()
      }
    },
  )
})
