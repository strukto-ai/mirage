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

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import git from 'isomorphic-git'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { IOResult } from '../../../../io/types.ts'
import { OpsRegistry } from '../../../../ops/registry.ts'
import { RAMResource } from '../../../../resource/ram/ram.ts'
import { MountMode } from '../../../../types.ts'
import { Workspace } from '../../../../workspace/workspace.ts'
import { gitFs } from './fs.ts'
import { ensureDir } from './io.ts'
import type { Dispatch } from './types.ts'

// The integ fixture builder, which is also what the differential harness hands
// the real git binary: one repository, half packed and half loose, so both read
// paths are exercised rather than only the easy one.
const BUILDER = fileURLToPath(
  new URL('../../../../../../../../integ/fixtures/git/build.sh', import.meta.url),
)

let tmp: string
let ws: Workspace
let fs: ReturnType<typeof gitFs>

/** Every file under a directory, as repository-relative POSIX paths. */
function walk(root: string, base = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mirage-git-fs-'))
  const repo = join(tmp, 'repo')
  execFileSync('bash', [BUILDER, repo], { stdio: 'ignore' })

  const ram = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  ws = new Workspace({ '/repo': ram }, { mode: MountMode.WRITE, ops: registry })
  // Copied into RAM rather than mounted from disk on purpose: a repository that
  // reads correctly out of a keyed store is proof the bridge goes through the
  // dispatcher and not through the filesystem underneath it.
  // The dispatcher's own contract: PathSpec in, [result, io] out, which is what
  // a CLI leaf is handed inside a workspace.
  const dispatch: Dispatch = async (op, path, args = [], kwargs = {}) => [
    await ws.dispatch(op, path.virtual, args, kwargs),
    new IOResult(),
  ]
  for (const rel of walk(repo)) {
    const target = `/repo/${rel}`
    await ensureDir(dispatch, target.slice(0, target.lastIndexOf('/')))
    await ws.dispatch('write', target, [new Uint8Array(readFileSync(join(repo, rel)))])
  }
  fs = gitFs(dispatch)
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const opts = (): { fs: never; dir: string; gitdir: string } => ({
  fs: fs as never,
  dir: '/repo',
  gitdir: '/repo/.git',
})

describe('gitFs', () => {
  it('reads history out of a mount', async () => {
    const log = await git.log(opts())
    expect(log.map((c) => c.commit.message.trim())).toEqual([
      'add two',
      'add docs',
      'add delta',
      'first commit',
    ])
  })

  it('reads a packed object, not only the loose half', async () => {
    // `repack -adq` packed the first three commits, so the oldest one only
    // resolves if the packfile and its index were both read through the mount.
    const log = await git.log(opts())
    const oldest = log[log.length - 1]
    expect(oldest).toBeDefined()
    const blob = await git.readBlob({ ...opts(), oid: oldest?.oid ?? '', filepath: 'letters.txt' })
    expect(new TextDecoder().decode(blob.blob)).toBe('alpha\nbeta\ngamma\n')
  })

  it('reads the branches', async () => {
    expect((await git.listBranches({ ...opts() })).sort()).toEqual(['main', 'topic'])
  })

  it('reads the index', async () => {
    expect((await git.listFiles(opts())).sort()).toEqual([
      'docs/readme.md',
      'letters.txt',
      'numbers.txt',
    ])
  })

  it('writes an object back through the mount', async () => {
    const oid = await git.writeBlob({ ...opts(), blob: new TextEncoder().encode('written\n') })
    const back = await git.readBlob({ ...opts(), oid })
    expect(new TextDecoder().decode(back.blob)).toBe('written\n')
  })
})
