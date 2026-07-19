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

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildWorkspaceFromConfig, resolveWorkspaceConfig } from './workspace_config.ts'

const tempDirs: string[] = []

function mkTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-workspace-config-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('resolveWorkspaceConfig', () => {
  it('resolves a named environment variable', () => {
    const dir = mkTempDir()
    const path = join(dir, 'custom.yaml')
    writeFileSync(path, 'mounts: {}\n')

    expect(
      resolveWorkspaceConfig(undefined, {
        cwd: dir,
        env: { MIRAGE_OPENCODE_CONFIG: path },
        envNames: ['MIRAGE_OPENCODE_CONFIG'],
      }),
    ).toBe(path)
  })

  it('searches parent directories for standard config names', () => {
    const dir = mkTempDir()
    const child = join(dir, 'src', 'nested')
    mkdirSync(child, { recursive: true })
    const path = join(dir, 'mirage.yaml')
    writeFileSync(path, 'mounts: {}\n')

    expect(resolveWorkspaceConfig(undefined, { cwd: child, env: {} })).toBe(path)
  })
})

describe('buildWorkspaceFromConfig', () => {
  it('builds a workspace from YAML', async () => {
    const dir = mkTempDir()
    const path = join(dir, 'workspace.yaml')
    writeFileSync(path, 'mounts:\n  /:\n    resource: ram\n')

    const workspace = await buildWorkspaceFromConfig(path)
    await workspace.fs.writeFile('/hello.txt', 'hello')

    expect(await workspace.fs.readFileText('/hello.txt')).toBe('hello')
    await workspace.close()
  })
})
