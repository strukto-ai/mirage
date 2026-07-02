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
import { RAMResource } from '../../resource/ram/ram.ts'
import { NodeKind } from '../../shell/node_kind.ts'
import { createShellParser } from '../../shell/parse.ts'
import { MountMode } from '../../types.ts'
import { Workspace } from '../workspace.ts'

const ENC = new TextEncoder()
const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

// Drift guard: every statement kind the executor supports must have a
// pinned provision expectation here. The map must cover the full enum
// (asserted below), so adding a NodeKind forces deciding what the
// planner reports for it; a construct can no longer be supported by
// the executor and silently mis-planned.
//
// The seeded file is 24 bytes. Expectations are
// [snippet, networkRead, networkWrite, precision].
const PLANS: Record<NodeKind, [string, string, string, string]> = {
  [NodeKind.COMMENT]: ['# a comment', '0', '0', 'exact'],
  [NodeKind.PROGRAM]: ['cat /data/a.txt; cat /data/a.txt', '48', '0', 'exact'],
  [NodeKind.COMMAND]: ['cat /data/a.txt', '24', '0', 'exact'],
  [NodeKind.PIPELINE]: ['cat /data/a.txt | wc -l', '24', '0', 'unknown'],
  [NodeKind.LIST]: ['cat /data/a.txt && cat /data/a.txt', '48', '0', 'exact'],
  [NodeKind.REDIRECT]: ['cat /data/a.txt > /data/out.txt', '24', '0-24', 'range'],
  [NodeKind.SUBSHELL]: ['(cat /data/a.txt)', '24', '0', 'exact'],
  [NodeKind.COMPOUND]: ['{ cat /data/a.txt; }', '24', '0', 'exact'],
  [NodeKind.IF]: ['if true; then cat /data/a.txt; fi', '0-24', '0', 'range'],
  [NodeKind.FOR]: ['for i in 1 2; do cat /data/a.txt; done', '48', '0', 'exact'],
  [NodeKind.SELECT]: ['select x in a b; do cat /data/a.txt; done', '24', '0', 'unknown'],
  [NodeKind.WHILE]: ['while true; do cat /data/a.txt; done', '24', '0', 'unknown'],
  [NodeKind.UNTIL]: ['until false; do cat /data/a.txt; done', '24', '0', 'unknown'],
  [NodeKind.CASE]: ['case x in x) cat /data/a.txt;; esac', '24', '0', 'range'],
  [NodeKind.FUNCTION_DEF]: ['f() { cat /data/a.txt; }', '0', '0', 'exact'],
  [NodeKind.DECLARATION]: ['export FOO=1', '0', '0', 'exact'],
  [NodeKind.UNSET]: ['unset FOO', '0', '0', 'exact'],
  [NodeKind.TEST]: ['[[ -n x ]]', '0', '0', 'exact'],
  [NodeKind.NEGATED]: ['! grep zzz /data/a.txt', '24', '0', 'exact'],
  [NodeKind.VAR_ASSIGN]: ['FOO=1', '0', '0', 'exact'],
  [NodeKind.UNSUPPORTED]: ['for ((i=0;i<2;i++)); do true; done', '0', '0', 'unknown'],
}

function buildWorkspace(): Workspace {
  return new Workspace(
    { '/data': new RAMResource() },
    {
      mode: MountMode.WRITE,
      shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
    },
  )
}

describe('planner covers every statement kind', () => {
  it('plans cover the full enum', () => {
    expect(new Set(Object.keys(PLANS))).toEqual(new Set(Object.values(NodeKind)))
  })

  for (const kind of Object.values(NodeKind)) {
    it(`plans ${kind}`, async () => {
      const [snippet, net, write, precision] = PLANS[kind]
      const ws = buildWorkspace()
      try {
        await ws.execute('tee /data/a.txt > /dev/null', { stdin: ENC.encode('x'.repeat(24)) })
        const result = await ws.execute(snippet, { provision: true })
        expect(result.networkRead, kind).toBe(net)
        expect(result.networkWrite, kind).toBe(write)
        expect(result.precision, kind).toBe(precision)
      } finally {
        await ws.close()
      }
    })
  }

  it('plans function calls, env prefixes, eval, and redirect reads', async () => {
    const ws = buildWorkspace()
    try {
      await ws.execute('tee /data/a.txt > /dev/null', { stdin: ENC.encode('x'.repeat(24)) })
      let result = await ws.execute('f() { cat /data/a.txt; }; f', { provision: true })
      expect(result.networkRead).toBe('24')
      expect(result.precision).toBe('exact')
      result = await ws.execute('f() { f; }; f', { provision: true })
      expect(result.precision).toBe('unknown')
      result = await ws.execute('FOO=1 cat /data/a.txt', { provision: true })
      expect(result.networkRead).toBe('24')
      expect(result.precision).toBe('exact')
      result = await ws.execute("eval 'cat /data/a.txt'", { provision: true })
      expect(result.precision).toBe('unknown')
      result = await ws.execute('wc -l < /data/a.txt', { provision: true })
      expect(result.networkRead).toBe('24')
      result = await ws.execute('cat /data/a.txt > /dev/null', { provision: true })
      expect(result.networkWrite).toBe('0')
      expect(result.precision).toBe('exact')
    } finally {
      await ws.close()
    }
  })
})
