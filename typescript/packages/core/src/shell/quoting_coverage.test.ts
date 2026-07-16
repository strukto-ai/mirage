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
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser, stdoutStr } from '../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

// Direct port of tests/shell/test_quoting_coverage.py.
// Each test is one realistic agent pattern — failures surface as parser,
// classifier (TEXT vs PATH), or expansion-time bugs.

const ENC = new TextEncoder()

async function makeQuotingWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ram = new RAMResource()
  ram.store.files.set('/plain.txt', ENC.encode('plain content\n'))
  ram.store.files.set('/my folder/note.txt', ENC.encode('in spaced folder\n'))
  ram.store.files.set('/my folder/My File.txt', ENC.encode('camelcase with space\n'))
  ram.store.files.set("/file's copy.txt", ENC.encode('with apostrophe\n'))
  ram.store.files.set('/数据/中文.txt', ENC.encode('unicode path content\n'))
  ram.store.dirs.add('/my folder')
  ram.store.dirs.add('/数据')

  const registry = new OpsRegistry()
  registry.registerResource(ram)

  const ws = new Workspace(
    { '/data': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  ws.getSession(ws.defaultSessionId).cwd = '/data'
  return ws
}

async function run(ws: Workspace, cmd: string): Promise<{ out: string; exit: number }> {
  const io = await ws.execute(cmd)
  return { out: stdoutStr(io), exit: io.exitCode }
}

describe('shell quoting coverage (port of tests/shell/test_quoting_coverage.py)', () => {
  describe('paths with spaces', () => {
    it('single-quoted path with space', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, "cat '/data/my folder/note.txt'")
      expect(r.out).toBe('in spaced folder\n')
      await ws.close()
    })

    it('double-quoted path with space', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'cat "/data/my folder/note.txt"')
      expect(r.out).toBe('in spaced folder\n')
      await ws.close()
    })

    it('ls directory with space', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, "ls '/data/my folder/'")
      expect(r.out).toContain('note.txt')
      await ws.close()
    })

    it('find name pattern with space', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, "find /data -name 'My File.txt'")
      expect(r.out).toContain('My File.txt')
      await ws.close()
    })
  })

  describe('paths with special chars', () => {
    it('double-quoted path with apostrophe inside', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'cat "/data/file\'s copy.txt"')
      expect(r.out).toBe('with apostrophe\n')
      await ws.close()
    })
  })

  describe('unicode in paths', () => {
    it('unicode path', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, "cat '/data/数据/中文.txt'")
      expect(r.out).toBe('unicode path content\n')
      await ws.close()
    })

    it('unicode directory listing', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'ls /data/数据/')
      expect(r.out).toContain('中文.txt')
      await ws.close()
    })
  })

  describe('env vars in paths', () => {
    it('env var in double-quoted path expands', async () => {
      const ws = await makeQuotingWs()
      await ws.execute('export DIR=/data')
      const r = await run(ws, 'cat "$DIR/plain.txt"')
      expect(r.out).toBe('plain content\n')
      await ws.close()
    })

    it('braced env var in double-quoted path expands', async () => {
      const ws = await makeQuotingWs()
      await ws.execute('export DIR=/data')
      const r = await run(ws, 'cat "${DIR}/plain.txt"')
      expect(r.out).toBe('plain content\n')
      await ws.close()
    })

    it('env var in single-quoted path is literal (no expansion)', async () => {
      const ws = await makeQuotingWs()
      await ws.execute('export DIR=/data')
      const r = await run(ws, "cat '$DIR/plain.txt'")
      // File doesn't literally exist → non-zero exit OR empty stdout.
      expect(r.exit !== 0 || r.out === '').toBe(true)
      await ws.close()
    })
  })

  describe('command substitution in args', () => {
    it('command sub produces a path used by cat', async () => {
      const ws = await makeQuotingWs()
      await ws.execute('echo /data/plain.txt > /data/path.txt')
      const r = await run(ws, 'cat $(cat /data/path.txt)')
      expect(r.out).toBe('plain content\n')
      await ws.close()
    })

    it('command sub in grep pattern', async () => {
      const ws = await makeQuotingWs()
      await ws.execute('echo plain > /data/needle.txt')
      const r = await run(ws, 'grep "$(cat /data/needle.txt)" /data/plain.txt')
      expect(r.out).toContain('plain content')
      await ws.close()
    })
  })

  describe('escaping', () => {
    it('escaped dollar in double quotes is literal $PATH', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'echo "\\$PATH"')
      expect(r.out.trim()).toBe('$PATH')
      await ws.close()
    })

    it("single-quoted '$PATH' is literal", async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, "echo '$PATH'")
      expect(r.out.trim()).toBe('$PATH')
      await ws.close()
    })

    it('double-quoted "$X" expands', async () => {
      const ws = await makeQuotingWs()
      await ws.execute('export X=hello')
      const r = await run(ws, 'echo "$X"')
      expect(r.out.trim()).toBe('hello')
      await ws.close()
    })
  })

  describe('unquoted backslash escapes (POSIX §2.2.1)', () => {
    it("close-escape-open: echo 'a'\\''b' → a'b", async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, "echo 'a'\\''b'")
      expect(r.out.trim()).toBe("a'b")
      await ws.close()
    })

    it('escaped space in path: cat /data/my\\ folder/note.txt', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'cat /data/my\\ folder/note.txt')
      expect(r.out).toBe('in spaced folder\n')
      await ws.close()
    })

    it('unquoted \\$ is literal $: echo \\$PATH', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'echo \\$PATH')
      expect(r.out.trim()).toBe('$PATH')
      await ws.close()
    })

    it('unquoted \\\\ is one backslash: echo \\\\', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'echo \\\\')
      expect(r.out).toBe('\\\n')
      await ws.close()
    })

    it('unquoted \\n is literal n: echo foo\\nbar', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'echo foo\\nbar')
      expect(r.out.trim()).toBe('foonbar')
      await ws.close()
    })
  })

  describe('edge cases', () => {
    it('empty string arg', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'echo ""')
      expect(r.out).toBe('\n')
      await ws.close()
    })

    it('consecutive quoted strings concatenate', async () => {
      const ws = await makeQuotingWs()
      const r = await run(ws, 'echo "a""b"')
      expect(r.out.trim()).toBe('ab')
      await ws.close()
    })

    it('grep pattern with escaped embedded quote', async () => {
      const ws = await makeQuotingWs()
      const mount2 = ws.mount('/data/')
      if (mount2 === null) throw new Error('/data/ mount missing')
      const ws2Ram = mount2.resource as RAMResource
      ws2Ram.store.files.set('/quote.txt', ENC.encode('she said "hi"\n'))
      const r = await run(ws, 'grep "she said \\"hi\\"" /data/quote.txt')
      expect(r.out).toContain('hi')
      await ws.close()
    })
  })

  describe('echo quoting matrix (parametrized in Python)', () => {
    const cases: [string, string][] = [
      ['hello world', 'hello world\n'],
      ["'inner'", "'inner'\n"],
      ['$NONEXISTENT', '\n'],
    ]
    for (const [input, expected] of cases) {
      it(`echo "${input}" → ${JSON.stringify(expected)}`, async () => {
        const ws = await makeQuotingWs()
        const r = await run(ws, `echo "${input}"`)
        expect(r.out).toBe(expected)
        await ws.close()
      })
    }
  })
})
