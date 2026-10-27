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
import { patchGeneric } from '../../commands/builtin/generic/patch.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import { runWithMountGate } from '../../context/session_context.ts'
import { Files } from '../../workspace/files.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

it.each(['', '/data', '/nested/data'])(
  'preserves virtual paths under %s for patch I/O',
  async (prefix) => {
    for (const source of ['stdin', 'operand', 'input']) {
      const diff = ENC.encode(
        '--- a/hello.txt\n+++ b/hello.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+universe\n',
      )
      const files = new Map<string, Uint8Array>([
        ['hello.txt', ENC.encode('hello\nworld\n')],
        ['fix.diff', diff],
      ])
      const seen: string[] = []
      const read = (path: PathSpec): Promise<Uint8Array> => {
        expect(path.virtual).toBe(prefix + '/' + path.vfsPath)
        seen.push(path.vfsPath)
        const bytes = files.get(path.vfsPath)
        if (bytes === undefined) throw new Error('missing fixture')
        return Promise.resolve(bytes)
      }
      const write = (path: PathSpec, data: Uint8Array): Promise<void> => {
        expect(path.virtual).toBe(prefix + '/' + path.vfsPath)
        files.set(path.vfsPath, data)
        return Promise.resolve()
      }
      const stat = (path: PathSpec): Promise<FileStat> => {
        expect(path.virtual).toBe(prefix + '/' + path.vfsPath)
        if (!files.has(path.vfsPath))
          return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
        return Promise.resolve(new FileStat({ name: path.vfsPath, type: FileType.FILE }))
      }
      const unexpected = (): Promise<void> => Promise.reject(new Error('unexpected change'))
      const input = PathSpec.fromStrPath(prefix + '/fix.diff', 'fix.diff')
      const orig = PathSpec.fromStrPath(prefix + '/hello.txt', 'hello.txt')
      // The mount the command runs on, as its scope binds it.
      await runWithMountGate(`${prefix}/`, MountMode.WRITE, () =>
        patchGeneric(
          source === 'operand' ? [orig, input] : [],
          {
            vfs: new Files(() => Promise.reject(new Error('no dispatch'))),
            cwd: PathSpec.fromStrPath(prefix || '/'),
            flags: { p: '1', ...(source === 'input' ? { i: input.virtual } : {}) },
            stdin: source === 'stdin' ? diff : null,
          },
          read,
          write,
          stat,
          { mkdir: unexpected, unlink: unexpected, rmdir: unexpected },
        ),
      )
      expect(seen).toContain('hello.txt')
      expect(DEC.decode(files.get('hello.txt'))).toBe('hello\nuniverse\n')
    }
  },
)
