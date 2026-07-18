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
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

async function singleMountWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const root = new RAMResource()
  ops.registerResource(root)
  return new Workspace({ '/': root }, { mode: MountMode.WRITE, ops, shellParser: parser })
}

async function twoMountWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const root = new RAMResource()
  const a = new RAMResource()
  const b = new RAMResource()
  ops.registerResource(root)
  ops.registerResource(a)
  ops.registerResource(b)
  return new Workspace(
    { '/': root, '/a': a, '/b': b },
    { mode: MountMode.WRITE, ops, shellParser: parser },
  )
}

async function setupHtmlFiles(ws: Workspace): Promise<void> {
  ws.createSession('s')
  await ws.execute('mkdir -p /a/b', { sessionId: 's' })
  await ws.execute('touch /foo.html /bar.htm /a/b/baz.html', { sessionId: 's' })
}

describe('find action layer', () => {
  describe('-delete', () => {
    it('removes matched files', async () => {
      const ws = await singleMountWs()
      await setupHtmlFiles(ws)
      const r = await ws.execute("find / -name '*.html' -delete", { sessionId: 's' })
      expect(r.exitCode).toBe(0)
      expect(r.stdoutText).toBe('')
      const after = await ws.execute("find / -name '*.html'", { sessionId: 's' })
      expect(after.stdoutText).toBe('')
      const htm = await ws.execute("find / -name '*.htm'", { sessionId: 's' })
      expect(htm.stdoutText).toContain('/bar.htm')
    })

    it('is silent unless -print is also given', async () => {
      const ws = await singleMountWs()
      await setupHtmlFiles(ws)
      const r = await ws.execute("find / -name '*.html' -delete", { sessionId: 's' })
      expect(r.stdoutText).toBe('')
    })

    it('emits matches when -print -delete is combined', async () => {
      const ws = await singleMountWs()
      await setupHtmlFiles(ws)
      const r = await ws.execute("find / -name '*.html' -print -delete", {
        sessionId: 's',
      })
      const out = r.stdoutText
      expect(out).toContain('/foo.html')
      expect(out).toContain('/a/b/baz.html')
    })

    it('skips mount roots', async () => {
      const ws = await twoMountWs()
      ws.createSession('s')
      await ws.execute('touch /a/x.html /b/y.html', { sessionId: 's' })
      // Without -name, /a and /b appear as synthetic dir entries.
      // -delete must skip them.
      await ws.execute('find / -type d -delete', { sessionId: 's' })
      const ls = await ws.execute('ls /', { sessionId: 's' })
      const out = ls.stdoutText
      expect(out).toContain('a')
      expect(out).toContain('b')
    })

    it('orders deepest-first so children clear before parents', async () => {
      const ws = await singleMountWs()
      ws.createSession('s')
      await ws.execute('mkdir -p /tmp/a/b', { sessionId: 's' })
      await ws.execute('touch /tmp/a/b/file.txt', { sessionId: 's' })
      const r = await ws.execute("find /tmp -name '*.txt' -delete", {
        sessionId: 's',
      })
      expect(r.exitCode).toBe(0)
    })

    it('removes directories emptied by the deepest-first pass', async () => {
      const ws = await singleMountWs()
      ws.createSession('s')
      await ws.execute('mkdir -p /tree/deep', { sessionId: 's' })
      await ws.execute('touch /tree/deep/f.txt', { sessionId: 's' })
      const r = await ws.execute('find /tree -delete', { sessionId: 's' })
      expect(r.exitCode).toBe(0)
      expect(r.stderrText).toBe('')
      const after = await ws.execute('find / -name tree', { sessionId: 's' })
      expect(after.stdoutText).toBe('')
    })
  })

  describe('-print0', () => {
    it('separates matches with NUL bytes', async () => {
      const ws = await singleMountWs()
      await setupHtmlFiles(ws)
      const r = await ws.execute("find / -name '*.html' -print0", { sessionId: 's' })
      const out = r.stdoutText
      expect(out).toContain('\x00')
      // No newlines outside the NUL separators.
      expect(out.split('\x00').join('')).not.toContain('\n')
      expect(out.endsWith('\x00')).toBe(true)
    })
  })

  describe('-ls', () => {
    it('emits long-format listing per match', async () => {
      const ws = await singleMountWs()
      await setupHtmlFiles(ws)
      const r = await ws.execute("find / -name '*.html' -ls", { sessionId: 's' })
      const lines = r.stdoutText.split('\n').filter((l) => l !== '')
      expect(lines.length).toBeGreaterThanOrEqual(2)
      for (const line of lines) {
        expect(line[0]).toMatch(/[-dl]/)
      }
    })
  })

  describe('default behavior', () => {
    it('find without action flags is unchanged', async () => {
      const ws = await singleMountWs()
      await setupHtmlFiles(ws)
      const r = await ws.execute("find / -name '*.html'", { sessionId: 's' })
      const out = r.stdoutText
      expect(out).toContain('/foo.html')
      expect(out).toContain('/a/b/baz.html')
      expect(out).not.toContain('\x00')
    })
  })

  describe('synthetic mount entries', () => {
    it('honors -name on mount roots', async () => {
      const ws = await twoMountWs()
      ws.createSession('s')
      const r = await ws.execute("find / -name 'a' -type d", { sessionId: 's' })
      const lines = r.stdoutText
        .trim()
        .split('\n')
        .filter((l) => l !== '')
      expect(lines).toContain('/a')
      expect(lines).not.toContain('/b')
    })
  })
})
