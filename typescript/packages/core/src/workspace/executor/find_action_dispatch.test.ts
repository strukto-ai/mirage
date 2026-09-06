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
import { OpsRegistry } from '../../ops/registry.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { MountMode } from '../../types.ts'
import type { Action, OpsContext, Policy } from '../../policy/index.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { SharedStdin } from './find_action_dispatch.ts'

class NoRmdir implements Policy {
  preOps(ctx: OpsContext): Action | null {
    return ctx.op === 'rmdir' ? { kind: 'deny', reason: 'no rmdir' } : null
  }
}

async function shellWs(policies: Policy[] = []): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const root = new RAMResource()
  ops.registerResource(root)
  const ws = new Workspace(
    { '/': root },
    { mode: MountMode.WRITE, ops, shellParser: parser, policies },
  )
  ws.createSession('s')
  return ws
}

describe('find actions', () => {
  it('substitutes the -exec head before looking it up', async () => {
    // GNU substitutes the match into the words and only then execs, so
    // `-exec {} \;` runs each match itself rather than looking up `{}`.
    const ws = await shellWs()
    try {
      const r = await ws.execute(
        "mkdir -p /data/fh/s; printf 'echo ran\\n' > /data/fh/s/x; chmod 700 /data/fh/s/x; cd /data/fh; find s -type f -exec {} \\; ; echo rc=$?",
        { sessionId: 's' },
      )
      expect(r.stdoutText).toBe('ran\nrc=0\n')
      expect(r.stderrText).toBe('')
    } finally {
      await ws.close()
    }
  })

  it("drops a deleted row's node meta", async () => {
    // A chmod that lives in the namespace overlay goes with the row, as
    // it does through `rm`, so a later file at the same name does not
    // inherit the removed one's mode.
    const ws = await shellWs()
    try {
      await ws.execute('mkdir -p /data/m; touch /data/m/f /data/m/d', { sessionId: 's' })
      await ws.namespace.setAttrs('/data/m/f', { mode: 0o600 })
      await ws.namespace.setAttrs('/data/m/d', { mode: 0o700 })
      expect(ws.namespace.metaFor('/data/m/f')).not.toBeNull()
      const r = await ws.execute('find /data/m -name f -delete; echo rc=$?', { sessionId: 's' })
      expect(r.stdoutText).toBe('rc=0\n')
      expect(ws.namespace.metaFor('/data/m/f')).toBeNull()
      expect(ws.namespace.metaFor('/data/m/d')).not.toBeNull()
    } finally {
      await ws.close()
    }
  })

  it('runs a program a function shadows', async () => {
    // execvp never sees a shell function, so `cat(){ ...; }` neither
    // hides the program from find nor runs in its place.
    const ws = await shellWs()
    try {
      const r = await ws.execute(
        "mkdir -p /data/sh; printf 'content\\n' > /data/sh/f; cd /data/sh; cat() { echo BAD; }; find . -type f -exec cat {} \\; ; echo rc=$?",
        { sessionId: 's' },
      )
      expect(r.stdoutText).toBe('content\nrc=0\n')
      expect(r.stderrText).toBe('')
    } finally {
      await ws.close()
    }
  })

  it('admits a directory deletion as rmdir', async () => {
    // A rule that refuses rmdir and allows unlink judges `find emptydir
    // -delete` as it judges `rmdir emptydir`.
    const ws = await shellWs([new NoRmdir()])
    try {
      const r = await ws.execute(
        'mkdir -p /data/rd/e; touch /data/rd/f; find /data/rd/f -delete; echo rc=$?; find /data/rd/e -delete; echo rc=$?; test -d /data/rd/e; echo $?',
        { sessionId: 's' },
      )
      expect(r.stdoutText).toBe('rc=0\nrc=1\n0\n')
      expect(r.stderrText).toContain("find: cannot delete '/data/rd/e': no rmdir")
    } finally {
      await ws.close()
    }
  })

  it("hands find's stdin to its -exec children", async () => {
    // GNU's children inherit find's stdin, and a pipe feeds one reader:
    // the first child takes it and the next reads EOF.
    const ws = await shellWs()
    try {
      const r = await ws.execute(
        'mkdir -p /data/fi/d; touch /data/fi/d/a /data/fi/d/b; cd /data/fi; printf x | find d -maxdepth 0 -exec cat \\; ; echo rc=$?; printf y | find d -type f -exec cat \\; ; echo rc=$?; printf z | find d -maxdepth 0 -exec true \\; -exec cat \\; ; echo rc=$?; printf abc | find d -maxdepth 0 -exec head -c 1 \\; -exec cat \\; ; echo rc=$?',
        { sessionId: 's' },
      )
      // A child that never reads (`true`) leaves the bytes for the next,
      // and one that reads part (`head -c 1`) leaves the rest.
      expect(r.stdoutText).toBe('xrc=0\nyrc=0\nzrc=0\nabcrc=0\n')
      expect(r.stderrText).toBe('')
    } finally {
      await ws.close()
    }
  })

  it('runs a program an alias shadows', async () => {
    // An alias is as invisible to execvp as a function: the program runs.
    const ws = await shellWs()
    try {
      await ws.execute("shopt -s expand_aliases; alias cat='echo BAD'", { sessionId: 's' })
      const r = await ws.execute(
        "mkdir -p /data/al; printf 'content\\n' > /data/al/f; cd /data/al; find . -type f -exec cat {} \\; ; echo rc=$?; command cat f",
        { sessionId: 's' },
      )
      expect(r.stdoutText).toBe('content\nrc=0\ncontent\n')
      expect(r.stderrText).toBe('')
    } finally {
      await ws.close()
    }
  })

  it('renders the stat find already holds for -ls', async () => {
    // GNU findutils 4.9: a start point is statted when the walk opens and
    // any other row only for a test that needs the inode, so `find d/f
    // -delete -ls` and `find d -name g -size -1k -delete -ls` list the row
    // they removed (exit 0) while `-type f -delete -ls` reports it gone.
    const ws = await shellWs()
    try {
      const r = await ws.execute(
        'mkdir -p /data/dl; touch /data/dl/f /data/dl/g; cd /data; find dl/f -delete -ls; echo rc=$?; find dl -name g -size -1k -delete -ls; echo rc=$?; find dl -type d -delete -ls; echo rc=$?; test -e dl; echo e=$?',
        { sessionId: 's' },
      )
      const lines = r.stdoutText.split('\n').filter((l) => l !== '')
      const rows = lines.filter((l) => / dl(\/[fg])?$/.test(l))
      expect(rows.map((row) => row.slice(row.lastIndexOf(' ') + 1))).toEqual(['dl/f', 'dl/g', 'dl'])
      expect(
        rows[0]
          ?.split(/\s+/)
          .filter((w) => w !== '')[2]
          ?.startsWith('-'),
      ).toBe(true)
      expect(
        rows[2]
          ?.split(/\s+/)
          .filter((w) => w !== '')[2]
          ?.startsWith('d'),
      ).toBe(true)
      expect(lines.filter((l) => l.startsWith('rc=') || l.startsWith('e='))).toEqual([
        'rc=0',
        'rc=0',
        'rc=0',
        'e=1',
      ])
      expect(r.stderrText).toBe('')
    } finally {
      await ws.close()
    }
  })

  it('runs the -exec head as a program', async () => {
    // execvp answers `printf` with coreutils printf, which has no -v: the
    // word is the format (GNU adds a warning about the excess arguments,
    // which mirage's printf does not report). A nested shell the line
    // starts is a shell again, so its printf assigns.
    const ws = await shellWs()
    try {
      const r = await ws.execute(
        'mkdir -p /data/fp; touch /data/fp/f; cd /data/fp; find . -type f -exec printf -v x hi \\; ; echo "[$x]"; find . -type f -exec sh -c \'printf -v y hi; echo "[$y]"\' \\; ; printf -v z hi; echo "[$z]"',
        { sessionId: 's' },
      )
      expect(r.stdoutText).toBe('-v[]\n[hi]\n[hi]\n')
      expect(r.stderrText).toBe('')
    } finally {
      await ws.close()
    }
  })

  it('reads a slow stdin incrementally for a child', async () => {
    // A source that never ends must still feed `head -c 1` its byte: the
    // cursor pulls a chunk at a time rather than waiting for EOF.
    async function* endless(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode('ab')
      await new Promise<void>(() => undefined)
    }
    const shared = new SharedStdin(endless())
    const got: string[] = []
    for await (const chunk of shared) {
      got.push(new TextDecoder().decode(chunk))
      if (got.length === 2) break
    }
    expect(got).toEqual(['a', 'b'])
  })
})
