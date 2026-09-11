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
import { FileStat, FileType, MountMode } from '../../types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { resolveNewerRefs } from './find_refs.ts'

async function shellWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const root = new RAMResource()
  ops.registerResource(root)
  const ws = new Workspace({ '/': root }, { mode: MountMode.WRITE, ops, shellParser: parser })
  ws.createSession('s')
  return ws
}

async function out(ws: Workspace, line: string): Promise<[string, string, number]> {
  const r = await ws.execute(line, { sessionId: 's' })
  return [r.stdoutText, r.stderrText, r.exitCode]
}

function stat(virtual: string): Promise<FileStat | null> {
  if (virtual === '/w/ref') {
    return Promise.resolve(
      new FileStat({ name: 'ref', type: FileType.FILE, modified: '2020-01-01T00:00:00Z' }),
    )
  }
  return Promise.resolve(null)
}

describe('resolveNewerRefs', () => {
  it('rewrites -newer into -newermt', async () => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    const [tokens, err] = await resolveNewerRefs(
      ['-newer', 'ref', '-name', 'x', '-newer', '/w/ref'],
      ['ref', '/w/ref'],
      ws.registry,
      '/w',
      stat,
    )
    expect(err).toBeNull()
    expect(tokens).toEqual([
      '-newermt',
      '2020-01-01T00:00:00.000Z',
      '-name',
      'x',
      '-newermt',
      '2020-01-01T00:00:00.000Z',
    ])
  })

  it("reports a missing reference in GNU's words", async () => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    const [tokens, err] = await resolveNewerRefs(
      ['-newer', 'nope'],
      ['nope'],
      ws.registry,
      '/w',
      stat,
    )
    expect(tokens).toEqual(['-newer', 'nope'])
    expect(new TextDecoder().decode(err ?? new Uint8Array())).toBe(
      "find: 'nope': No such file or directory\n",
    )
  })

  it('intersects repeated -newer references', async () => {
    // GNU find 4.9: `-newer old -newer new` keeps only what is newer than
    // both references.
    const ws = await shellWs()
    try {
      await ws.execute(
        'printf o > /w/old; printf c > /w/cand; printf n > /w/new; cd /w; ' +
          "touch -d '2020-01-01 00:00:00' old; " +
          "touch -d '2021-01-01 00:00:00' cand; " +
          "touch -d '2022-01-01 00:00:00' new",
        { sessionId: 's' },
      )
      expect(await out(ws, 'find cand -newer old -newer new')).toEqual(['', '', 0])
      expect(await out(ws, 'find cand -newer new -newer old')).toEqual(['', '', 0])
      expect(await out(ws, 'find cand -newer old')).toEqual(['cand\n', '', 0])
      expect(await out(ws, 'find cand -newermt 2020-06-01 -newermt 2021-06-01')).toEqual([
        '',
        '',
        0,
      ])
    } finally {
      await ws.close()
    }
  })

  it('reads a link reference by the link policy', async () => {
    // GNU find 4.9: -P (the default) compares against a symlink's own
    // mtime, -H and -L against its target's; a dangling reference is its
    // own row under every policy; a loop is an ordinary reference under
    // -P and a refusal when followed.
    const ws = await shellWs()
    try {
      await ws.execute(
        'mkdir -p /w/d; printf t > /w/target; printf c > /w/d/cand; cd /w; ' +
          "touch -d '2020-01-01 00:00:00' target; " +
          "touch -d '2021-01-01 00:00:00' d/cand; " +
          "touch -d '2019-01-01 00:00:00' d; " +
          "ln -s target link; touch -h -d '2022-01-01 00:00:00' link; " +
          "ln -s nowhere dangling; touch -h -d '2020-06-01 00:00:00' dangling; " +
          'ln -s loop1 loop2; ln -s loop2 loop1; ' +
          "touch -h -d '2022-01-01 00:00:00' loop1",
        { sessionId: 's' },
      )
      expect(await out(ws, 'find d -newer link')).toEqual(['', '', 0])
      expect(await out(ws, 'find -L d -newer link')).toEqual(['d/cand\n', '', 0])
      expect(await out(ws, 'find -H d -newer link')).toEqual(['d/cand\n', '', 0])
      expect(await out(ws, 'find -L -P d -newer link')).toEqual(['', '', 0])
      expect(await out(ws, 'find d -newer dangling')).toEqual(['d/cand\n', '', 0])
      expect(await out(ws, 'find -L d -newer dangling')).toEqual(['d/cand\n', '', 0])
      expect(await out(ws, 'find d -newer loop1')).toEqual(['', '', 0])
      expect(await out(ws, 'find -L d -newer loop1')).toEqual([
        '',
        "find: 'loop1': Too many levels of symbolic links\n",
        1,
      ])
    } finally {
      await ws.close()
    }
  })
})
