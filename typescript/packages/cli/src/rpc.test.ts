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

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { RPC_ENV_NAMES, resolveRpcConfig } from './rpc.ts'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin', 'mirage.js')
const MINIMAL = 'mounts:\n  /:\n    vfs: ram\n    mode: WRITE\n'
const tempDirs: string[] = []

function mkTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-rpc-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('mirage rpc', () => {
  it('reads the rpc config names first', () => {
    expect(RPC_ENV_NAMES).toEqual(['MIRAGE_RPC_CONFIG', 'MIRAGE_CONFIG'])
    const dir = mkTempDir()
    writeFileSync(join(dir, 'w.yaml'), MINIMAL)
    expect(resolveRpcConfig(undefined, { env: { MIRAGE_RPC_CONFIG: join(dir, 'w.yaml') } })).toBe(
      join(dir, 'w.yaml'),
    )
  })

  it('takes a config or a workspace, not both', async () => {
    const child = spawn(process.execPath, [BIN, 'rpc', 'cfg.yaml', '-w', 'ws_1'])
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    expect(code).toBe(2)
  })
})
