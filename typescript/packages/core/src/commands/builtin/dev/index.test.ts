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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { Action, VfsContext } from '../../../policy/index.ts'
import { createShellParser } from '../../../shell/parse/index.ts'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

describe('a file in /dev is read at the dispatcher', () => {
  // cat and head read /dev in ranges, which /dev/zero answers without end;
  // each range is a dispatcher read, so a policy refusing the file is asked
  // before any byte is printed.
  it.each(['cat', 'head -n 1'])('%s', async (command) => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
        policies: [
          {
            preVfs: (ctx: VfsContext): Action | null =>
              !ctx.write && ctx.path.virtual === '/dev/secret'
                ? { kind: 'deny', reason: 'sealed' }
                : null,
          },
        ],
      },
    )
    try {
      await ws.shell('echo s > /dev/secret')
      const denied = await ws.shell(`${command} /dev/secret`)
      expect(denied.stdoutText).toBe('')
      expect(denied.refusal?.reason).toBe('sealed')
      const zero = await ws.shell(`${command} /dev/zero | head -c 3 | wc -c`)
      expect(zero.stdoutText).toBe('3\n')
    } finally {
      await ws.close()
    }
  })
})
