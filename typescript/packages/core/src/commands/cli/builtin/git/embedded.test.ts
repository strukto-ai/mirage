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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { MountMode, PathSpec } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { embeddedHead, embeddedLocation } from './embedded.ts'
import { ensureDir } from './io.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A workspace holding every file under `root` at `/w`. */
async function mounted(root: string): Promise<Workspace> {
  const ws = new Workspace({ '/w': new RAMVFS() }, { mode: MountMode.WRITE })
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    )
  for (const file of walk(root)) {
    const target = PathSpec.fromStrPath(`/w/${relative(root, file)}`)
    await ensureDir(ws.vfs, target.parent)
    await ws.dispatch('write', target.virtual, [new Uint8Array(readFileSync(file))])
  }
  return ws
}

/** A repository at `path` with one commit; that commit. */
function repo(path: string): string {
  mkdirSync(path, { recursive: true })
  const git = ['-C', path, '-c', 'user.name=a', '-c', 'user.email=a@b']
  execFileSync('git', [...git, 'init', '-q'])
  writeFileSync(join(path, 'f'), 'f\n')
  execFileSync('git', [...git, 'add', '.'])
  execFileSync('git', [...git, 'commit', '-qm', 'f'])
  return execFileSync('git', [...git, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

it('finds a repository and follows its HEAD through a symbolic ref', async () => {
  const root = mkdtempSync(join(tmpdir(), 'embedded-'))
  roots.push(root)
  const head = repo(join(root, 'sub'))
  const branch = execFileSync('git', ['-C', join(root, 'sub'), 'symbolic-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  writeFileSync(join(root, 'sub/.git/refs/heads/alias'), `ref: ${branch}\n`)
  writeFileSync(join(root, 'sub/.git/HEAD'), 'ref: refs/heads/alias\n')
  const ws = await mounted(root)
  try {
    const location = await embeddedLocation(ws.vfs, PathSpec.fromStrPath('/w/sub'))
    expect(location).not.toBeNull()
    if (location !== null) expect(await embeddedHead(ws.vfs, location)).toBe(head)
  } finally {
    await ws.close()
  }
})

it('takes a .git that is no repository for none', async () => {
  const root = mkdtempSync(join(tmpdir(), 'embedded-'))
  roots.push(root)
  mkdirSync(join(root, 'lib/.git'), { recursive: true })
  writeFileSync(join(root, 'lib/.git/HEAD'), 'ref: refs/heads/main\n')
  const ws = await mounted(root)
  try {
    expect(await embeddedLocation(ws.vfs, PathSpec.fromStrPath('/w/lib'))).toBeNull()
  } finally {
    await ws.close()
  }
})
