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

import { expect, it } from 'vitest'
import { eacces, enoent } from '../../../utils/errors.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { unzipGeneric } from './unzip.ts'

// sec/a.txt then ok.txt, both stored.
const ARCHIVE =
  'UEsDBBQAAAAAAIAYIlyLntnTAQAAAAEAAAAJAAAAc2VjL2EudHh0QVBLAwQUAAAAAACAGCJcLdk21wIAAAACAAAABgAAAG9rLnR4dE9LUEsBAhQDFAAAAAAAgBgiXIue2dMBAAAAAQAAAAkAAAAAAAAAAAAAAIABAAAAAHNlYy9hLnR4dFBLAQIUAxQAAAAAAIAYIlwt2TbXAgAAAAIAAAAGAAAAAAAAAAAAAACAASgAAABvay50eHRQSwUGAAAAAAIAAgBrAAAATgAAAAAA'

it('a refused probe still reports the entry and goes on', async () => {
  // The level a member needs cannot be searched, so its mkdir fails and so
  // does the stat that looks for a file in the way; Info-ZIP reports the
  // member with a checkdir error, extracts the next one and exits 2.
  const data = Uint8Array.from(atob(ARCHIVE), (c) => c.charCodeAt(0))
  const written = new Map<string, Uint8Array>()
  async function* read(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    yield data
  }
  const stat = (path: PathSpec): Promise<FileStat> => {
    if (path.virtual.startsWith('/out/sec')) return Promise.reject(eacces(path))
    if (path.virtual === '/out') {
      return Promise.resolve(new FileStat({ name: 'out', type: FileType.DIRECTORY }))
    }
    return Promise.reject(enoent(path))
  }
  const result = await unzipGeneric(
    [PathSpec.fromStrPath('/a.zip')],
    [],
    { flags: { d: '/out', q: true }, stdin: null, filetypeFns: null, cwd: '/' },
    read,
    (path, bytes) => {
      written.set(path.virtual, bytes)
      return Promise.resolve()
    },
    (path) => Promise.reject(eacces(path)),
    stat,
  )
  if (result === null) throw new Error('unzip returned no result')
  const [, io] = result
  expect([...written.keys()]).toEqual(['/out/ok.txt'])
  expect(io.exitCode).toBe(2)
  expect(await io.stderrStr()).toMatch(/unable to process sec\/a\.txt\.\n$/)
})
