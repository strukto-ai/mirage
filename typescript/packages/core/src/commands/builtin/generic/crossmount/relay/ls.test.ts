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
import type { NamespaceView } from '../../../../../ops/types.ts'
import { FileStat, FileType, PathSpec } from '../../../../../types.ts'
import { enotdir } from '../../../../../utils/errors.ts'
import { mountKey } from '../../../../../utils/key_prefix.ts'
import { rstripSlash } from '../../../../../utils/slash.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import type { DispatchFn } from '../types.ts'
import { runLs } from './ls.ts'

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
    resourcePath: mountKey(path, ''),
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
  ns?: NamespaceView,
  roots: ReadonlySet<string> = new Set(),
): Promise<{ out: string; io: IOResult; calls: Calls }> {
  const calls: Calls = { readdir: [], stat: [] }
  const [out, io] = await runLs(paths.map(spec), flags, makeDispatch(calls, roots), ns)
  const text = out === null ? '' : new TextDecoder().decode(await materialize(out))
  return { out: text, io, calls }
}

describe('runLs — cross-mount ls', () => {
  it('heads and sorts operands on different mounts together', async () => {
    // GNU: `ls a b` names each directory, sorted, blank line between.
    const { out, io } = await run(['/a/one', '/b/two'])
    expect(out).toBe('/a/one:\nx.txt\n\n/b/two:\ny.txt\n')
    expect(io.exitCode).toBe(0)
  })

  it('does not let command-line order survive the global sort', async () => {
    // GNU prints `ls b a` identically to `ls a b`.
    const forward = await run(['/a', '/b'])
    const reversed = await run(['/b', '/a'])
    expect(reversed.out).toBe(forward.out)
    expect(forward.out).toBe('/a:\none\nz.txt\n\n/b:\ntwo\n')
  })

  it('prints a file operand first, unheaded', async () => {
    const { out } = await run(['/b/two', '/a/z.txt'])
    expect(out).toBe('/a/z.txt\n\n/b/two:\ny.txt\n')
  })

  it('never relays the caller index to another mount', async () => {
    // An index belongs to one mount, so operand A's index cannot answer
    // for mount B; the relayed op consults its own mount's index.
    const { calls } = await run(['/a', '/b'])
    expect(calls.readdir).toEqual(['/a', '/b'])
  })

  it('still reaches the rows with the namespace attr overlay', async () => {
    // A naive relay would report the raw backend mode and silently lose a
    // chmod the namespace holds.
    const overlay = (virtual: string, st: FileStat): FileStat =>
      virtual === '/a/z.txt' ? st.with({ mode: 0o600 }) : st
    const { out } = await run(['/a', '/b'], { args_l: true }, { statOverlay: overlay })
    expect(out).toContain('-rw-------')
    expect(out.split('-rw-------').length - 1).toBe(1)
  })

  it('lists the same names without a namespace', async () => {
    const none = await run(['/a', '/b'])
    const empty = await run(['/a', '/b'], {}, {})
    expect(empty.out).toBe(none.out)
  })

  it('interleaves each operand subtree under -R', async () => {
    const { out } = await run(['/a', '/b'], { R: true })
    expect(out).toBe('/a:\none\nz.txt\n\n/a/one:\nx.txt\n\n/b:\ntwo\n\n/b/two:\ny.txt\n')
  })

  it('prints bare rows with no headers under -d', async () => {
    const { out } = await run(['/a', '/b'], { d: true })
    expect(out).toBe('/a\n/b\n')
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
    const rec = await run(['/a', '/b'], { R: true }, undefined, nested)
    expect(rec.out).toBe('/a:\none\nz.txt\n\n/a/one:\nx.txt\n\n/b:\ntwo\n\n/b/two:\ny.txt\n')
  })

  // The mount table names the boundaries a walk's readdir cannot cross,
  // and a relayed one crosses them: readdir and stat route per path.
  // Handed the whole namespace — which is what the workspace offers —
  // the relay must still descend `/a/one` and render its group, because
  // nothing runs behind a relay to contribute it the way the fan-out
  // does for a single-mount run.
  it('is not stopped at a mount root by a full namespace', async () => {
    const nested = new Set(['/a/one'])
    const ns: NamespaceView = {
      mounts: {
        descendants: () => [],
        visibleDescendants: () => [],
        isRoot: (p) => nested.has(rstripSlash(p)),
        rootOf: () => '/',
      },
      childMounts: (parent) => (parent === '/a' ? ['one'] : []),
    }
    const { out, io } = await run(['/a', '/b'], { R: true }, ns, nested)
    expect(io.exitCode).toBe(0)
    expect(out).toBe('/a:\none\nz.txt\n\n/a/one:\nx.txt\n\n/b:\ntwo\n\n/b/two:\ny.txt\n')
  })

  it('lists each operand once', async () => {
    // Relaying replaces a native run per operand; it must not turn into a
    // listing per operand per mount.
    const { calls } = await run(['/a', '/b'])
    expect(calls.readdir).toEqual(['/a', '/b'])
  })
})
