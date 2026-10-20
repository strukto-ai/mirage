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
import { IOResult, materialize } from '../../../../../io/types.ts'
import { Files } from '../../../../../workspace/files.ts'
import { FileStat, FileType, PathSpec } from '../../../../../types.ts'
import { enotdir } from '../../../../../errors/fs.ts'
import { mountKey } from '../../../../../utils/key_prefix.ts'
import { rstripSlash } from '../../../../../utils/slash.ts'
import type { SessionView } from '../../../../../view/types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import type { DispatchFn } from '../types.ts'
import { runLs } from './ls.ts'
import { readers } from '../../../../../test-utils.ts'

// Two mounts, /a/ and /b/, as a plain virtual-path tree. The relayed
// primitives route by full virtual path, so one table stands for both, and
// readdir answers in full paths the way a backend's does.
const TREE: Record<string, string[]> = {
  '/a': ['/a/one', '/a/z.txt'],
  '/a/one': ['/a/one/x.txt'],
  '/b': ['/b/two'],
  '/b/two': ['/b/two/y.txt'],
}

interface Calls {
  readdir: string[]
  stat: string[]
}

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    vfsPath: mountKey(path, ''),
  })
}

// `roots` are paths that are another mount's root, and so answer stat with
// that mount's own name for itself.
function makeDispatch(calls: Calls, roots: ReadonlySet<string>): DispatchFn {
  return (op: string, path: PathSpec) => {
    const k = rstripSlash(path.virtual) === '' ? '/' : rstripSlash(path.virtual)
    const isDir = k in TREE
    if (op === 'readdir') {
      calls.readdir.push(k)
      if (!isDir) return Promise.reject(enotdir(k))
      return Promise.resolve([[...(TREE[k] ?? [])], new IOResult()])
    }
    calls.stat.push(k)
    return Promise.resolve([
      new FileStat({
        name: roots.has(k) ? '/' : (k.split('/').pop() ?? ''),
        size: isDir ? 0 : 3,
        type: isDir ? FileType.DIRECTORY : FileType.FILE,
        mode: isDir ? 0o755 : 0o644,
      }),
      new IOResult(),
    ])
  }
}

async function run(
  paths: string[],
  flags: Record<string, FlagValue> = {},
  vfs?: Files,
  roots: ReadonlySet<string> = new Set(),
): Promise<{ out: string; io: IOResult; calls: Calls }> {
  const calls: Calls = { readdir: [], stat: [] }
  const [out, io] = await runLs(paths.map(spec), flags, makeDispatch(calls, roots), vfs)
  const text = out === null ? '' : new TextDecoder().decode(await materialize(out))
  return { out: text, io, calls }
}

describe('runLs — cross-mount ls', () => {
  it('never relays the caller index to another mount', async () => {
    // An index belongs to one mount, so operand A's index cannot answer
    // for mount B; the relayed op consults its own mount's index.
    const { calls } = await run(['/a', '/b'])
    expect(calls.readdir).toEqual(['/a', '/b'])
  })

  it('leaves a lone operand unheaded', async () => {
    // runLs is only reached for multi-mount lines, but the generic's own
    // rule is operand count, so a single operand must stay bare.
    const { out } = await run(['/a/one'])
    expect(out).toBe('x.txt\n')
  })

  it('keeps a nested mount root named as its parent lists it', async () => {
    // A mount answers its own root with its own name for it ('/'), so a
    // relayed stat that crossed the boundary has to be renamed from the
    // path it was asked about. Left alone the row renders as '/', and -R
    // then descends into '/a' + '/' — which is /a again, unbounded.
    const nested = new Set(['/a/one'])
    const plain = await run(['/a', '/b'])
    const crossing = await run(['/a', '/b'], {}, undefined, nested)
    expect(crossing.out).toBe(plain.out)
    const rec = await run(['/a', '/b'], { recursive: true }, undefined, nested)
    expect(rec.out).toBe('/a:\none\nz.txt\n\n/a/one:\nx.txt\n\n/b:\ntwo\n\n/b/two:\ny.txt\n')
  })

  // The mount table names the boundaries a walk's readdir cannot cross,
  // and a relayed one crosses them: readdir and stat route per path.
  // Handed the session's files, whose mount table holds `/a/one`, the relay
  // must still descend it and render its group, because nothing runs behind
  // a relay to contribute it the way the fan-out does for a single-mount run.
  it('is not stopped at a mount root by the mount table', async () => {
    const nested = new Set(['/a/one'])
    const calls: Calls = { readdir: [], stat: [] }
    const files = new Files(makeDispatch(calls, nested), readers(['/a/', '/a/one/', '/b/']))
    const { out, io } = await run(['/a', '/b'], { recursive: true }, files, nested)
    expect(io.exitCode).toBe(0)
    expect(out).toBe('/a:\none\nz.txt\n\n/a/one:\nx.txt\n\n/b:\ntwo\n\n/b/two:\ny.txt\n')
  })

  // An entry with no uid or gid takes the session's profile as owner and
  // group, the same whether the line spans one mount or several. Mirrors
  // test_ls.py.
  it("names the session's profile in a long listing", async () => {
    const view = { profile: () => 'reviewer' } as unknown as SessionView
    const calls: Calls = { readdir: [], stat: [] }
    const [out] = await runLs(
      ['/a/z.txt', '/b/two/y.txt'].map(spec),
      { args_l: true },
      makeDispatch(calls, new Set()),
      undefined,
      view,
    )
    expect(new TextDecoder().decode(await materialize(out))).toBe(
      '-rw-r--r-- 1 reviewer reviewer 3 - /a/z.txt\n-rw-r--r-- 1 reviewer reviewer 3 - /b/two/y.txt\n',
    )
  })
})
