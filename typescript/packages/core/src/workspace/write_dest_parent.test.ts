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

const DEC = new TextDecoder()

async function ws(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const root = new RAMResource()
  ops.registerResource(root)
  return new Workspace({ '/': root }, { mode: MountMode.WRITE, ops, shellParser: parser })
}

describe('touch reports an unusable destination like GNU', () => {
  it('a missing parent is reported on the operand', async () => {
    const w = await ws()
    try {
      const io = await w.execute('touch /missing/f.txt')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe(
        "touch: cannot touch '/missing/f.txt': No such file or directory\n",
      )
    } finally {
      await w.close()
    }
  }, 30_000)

  it('a missing parent leaves no orphan', async () => {
    const w = await ws()
    try {
      await w.execute('touch /missing/f.txt')
      const listing = await w.execute('ls /')
      expect(listing.exitCode).toBe(0)
      expect(DEC.decode(listing.stdout)).not.toContain('missing')
    } finally {
      await w.close()
    }
  }, 30_000)

  it('a parent that is a plain file is Not a directory', async () => {
    const w = await ws()
    try {
      await w.execute('echo x > /plain')
      const io = await w.execute('touch /plain/f.txt')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe("touch: cannot touch '/plain/f.txt': Not a directory\n")
    } finally {
      await w.close()
    }
  }, 30_000)

  it('a plain file deeper in the chain is Not a directory', async () => {
    const w = await ws()
    try {
      await w.execute('echo x > /plain')
      const io = await w.execute('touch /plain/sub/f.txt')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe(
        "touch: cannot touch '/plain/sub/f.txt': Not a directory\n",
      )
    } finally {
      await w.close()
    }
  }, 30_000)

  it('keeps going after a failed operand', async () => {
    // GNU reports the bad operand and still creates the rest, exiting 1.
    const w = await ws()
    try {
      const io = await w.execute('touch /ok1.txt /missing/f.txt /ok2.txt')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe(
        "touch: cannot touch '/missing/f.txt': No such file or directory\n",
      )
      const listing = DEC.decode((await w.execute('ls /')).stdout)
      expect(listing).toContain('ok1.txt')
      expect(listing).toContain('ok2.txt')
    } finally {
      await w.close()
    }
  }, 30_000)
})

describe('mkdir reports an unusable destination like GNU', () => {
  it('a missing parent is reported on the operand', async () => {
    const w = await ws()
    try {
      const io = await w.execute('mkdir /missing/sub')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe(
        "mkdir: cannot create directory '/missing/sub': No such file or directory\n",
      )
    } finally {
      await w.close()
    }
  }, 30_000)

  it('a parent that is a plain file is Not a directory', async () => {
    const w = await ws()
    try {
      await w.execute('echo x > /plain')
      const io = await w.execute('mkdir /plain/sub')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe(
        "mkdir: cannot create directory '/plain/sub': Not a directory\n",
      )
    } finally {
      await w.close()
    }
  }, 30_000)

  it('keeps going after a failed operand', async () => {
    const w = await ws()
    try {
      const io = await w.execute('mkdir /ok1 /missing/sub /ok2')
      expect(io.exitCode).toBe(1)
      const listing = DEC.decode((await w.execute('ls /')).stdout)
      expect(listing).toContain('ok1')
      expect(listing).toContain('ok2')
    } finally {
      await w.close()
    }
  }, 30_000)
})

describe('redirect and tee report an unusable destination like GNU', () => {
  // Deliberate divergence, pinned elsewhere: mirage names the redirect
  // target without a `bash: line N:` prefix, since it is not bash.
  it('a redirect into a missing parent names the target', async () => {
    const w = await ws()
    try {
      const io = await w.execute('echo hi > /missing/f.txt')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe('/missing/f.txt: No such file or directory\n')
    } finally {
      await w.close()
    }
  }, 30_000)

  it('a redirect under a plain file is Not a directory', async () => {
    const w = await ws()
    try {
      await w.execute('echo x > /plain')
      const io = await w.execute('echo hi > /plain/f.txt')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe('/plain/f.txt: Not a directory\n')
    } finally {
      await w.close()
    }
  }, 30_000)

  it('an append into a missing parent names the target', async () => {
    const w = await ws()
    try {
      const io = await w.execute('echo hi >> /missing/f.txt')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe('/missing/f.txt: No such file or directory\n')
    } finally {
      await w.close()
    }
  }, 30_000)

  it('tee reports the strerror, not the backend exception text', async () => {
    const w = await ws()
    try {
      const io = await w.execute('echo hi | tee /missing/f.txt')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe('tee: /missing/f.txt: No such file or directory\n')
      // GNU tee still copies stdin to stdout on a write error.
      expect(DEC.decode(io.stdout)).toBe('hi\n')
    } finally {
      await w.close()
    }
  }, 30_000)
})
