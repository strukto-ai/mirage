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
import { RAMResource } from '../../../resource/ram/ram.ts'
import { createShellParser } from '../../../shell/parse.ts'
import { ConsistencyPolicy, MountMode, PathSpec, ResourceName } from '../../../types.ts'
import { Workspace } from '../../workspace.ts'
import { dropServiceCaches } from './run.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

function warmWorkspace(): [Workspace, RAMResource] {
  const ram = new RAMResource()
  // An account CLI's service caches reads, so a body already read is served
  // warm; forcing it on RAM reproduces that without a network backend.
  ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
  const ws = new Workspace(
    { '/r': ram },
    {
      mode: MountMode.WRITE,
      consistency: ConsistencyPolicy.LAZY,
      shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
    },
  )
  return [ws, ram]
}

describe('dropServiceCaches', () => {
  it('drops bodies as well as listings after a CLI write', async () => {
    // A stale listing hides a create; a stale body hides an edit. The cached
    // body is the one that answers without reaching the service, so clearing
    // the index alone leaves `cat` serving pre-write content.
    const [ws, ram] = warmWorkspace()
    try {
      await ram.writeFile(PathSpec.fromStrPath('/a.txt'), ENC.encode('v1\n'))
      expect(DEC.decode((await ws.execute('cat /r/a.txt')).stdout)).toContain('v1')
      await ram.writeFile(PathSpec.fromStrPath('/a.txt'), ENC.encode('v2\n'))
      await ram.writeFile(PathSpec.fromStrPath('/new.txt'), ENC.encode('fresh\n'))
      await dropServiceCaches(ws.registry, [ResourceName.RAM])
      expect(DEC.decode((await ws.execute('cat /r/a.txt')).stdout)).toContain('v2')
      expect(DEC.decode((await ws.execute('ls /r')).stdout)).toContain('new.txt')
    } finally {
      await ws.close()
    }
  })

  it('drops nothing for a CLI that serves nothing', async () => {
    const [ws, ram] = warmWorkspace()
    try {
      await ram.writeFile(PathSpec.fromStrPath('/a.txt'), ENC.encode('v1\n'))
      await ws.execute('cat /r/a.txt')
      await ram.writeFile(PathSpec.fromStrPath('/a.txt'), ENC.encode('v2\n'))
      await dropServiceCaches(ws.registry, [])
      expect(DEC.decode((await ws.execute('cat /r/a.txt')).stdout)).toContain('v1')
    } finally {
      await ws.close()
    }
  })

  it('leaves an unrelated service its cache', async () => {
    const [ws, ram] = warmWorkspace()
    try {
      await ram.writeFile(PathSpec.fromStrPath('/a.txt'), ENC.encode('v1\n'))
      await ws.execute('cat /r/a.txt')
      await ram.writeFile(PathSpec.fromStrPath('/a.txt'), ENC.encode('v2\n'))
      await dropServiceCaches(ws.registry, [ResourceName.GDRIVE])
      expect(DEC.decode((await ws.execute('cat /r/a.txt')).stdout)).toContain('v1')
    } finally {
      await ws.close()
    }
  })
})
