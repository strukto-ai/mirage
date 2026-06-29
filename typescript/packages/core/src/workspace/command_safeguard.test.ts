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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse.ts'
import { CommandSafeguard, MountMode, OnExceed } from '../types.ts'
import { Workspace } from './workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))
const DEC = new TextDecoder()
const ENC = new TextEncoder()

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

function buildWs(nLines: number): Workspace {
  const ram = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  const body = Array.from({ length: nLines }, (_, i) => `line${String(i)}\n`).join('')
  ram.store.files.set('/big.txt', ENC.encode(body))
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops: registry, shellParser: parser })
}

function overrideSafeguard(ws: Workspace, name: string, sg: CommandSafeguard): void {
  for (const m of ws.registry.allMounts()) m.commandSafeguards.set(name, sg)
}

async function runCmd(
  ws: Workspace,
  cmd: string,
): Promise<{ code: number; out: string; err: string }> {
  try {
    const res = await ws.execute(cmd)
    return { code: res.exitCode, out: DEC.decode(res.stdout), err: DEC.decode(res.stderr) }
  } finally {
    await ws.close()
  }
}

describe('Workspace command safeguard', () => {
  it('cat truncates at default 2000 lines', async () => {
    const ws = buildWs(2500)
    const { code, out, err } = await runCmd(ws, 'cat /big.txt')
    expect(code).toBe(0)
    expect(out.split('\n').length - 1).toBe(2000)
    expect(out.startsWith('line0\n')).toBe(true)
    expect(out).toContain('line1999\n')
    expect(out).not.toContain('line2000')
    expect(err).toContain('truncated')
  })

  it('intermediate pipe stage stays uncapped', async () => {
    const ws = buildWs(2500)
    const { code, out } = await runCmd(ws, 'cat /big.txt | wc -l')
    expect(code).toBe(0)
    expect(out.trim()).toBe('2500')
  })

  it('terminal pipe under limit emits no notice', async () => {
    const ws = buildWs(2500)
    const { code, out, err } = await runCmd(ws, 'cat /big.txt | tail -n 3')
    expect(code).toBe(0)
    expect(out).toBe('line2497\nline2498\nline2499\n')
    expect(err).not.toContain('truncated')
  })

  it('mount override caps below default', async () => {
    const ws = buildWs(5)
    overrideSafeguard(ws, 'cat', new CommandSafeguard({ maxLines: 3 }))
    const { code, out, err } = await runCmd(ws, 'cat /big.txt')
    expect(code).toBe(0)
    expect(out).toBe('line0\nline1\nline2\n')
    expect(err).toContain('truncated')
  })

  it('commandSafeguards constructor option caps below default', async () => {
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    ram.store.files.set('/big.txt', ENC.encode('line0\nline1\nline2\nline3\nline4\n'))
    const ws = new Workspace(
      { '/': ram },
      {
        mode: MountMode.WRITE,
        ops: registry,
        shellParser: parser,
        commandSafeguards: { '/': { cat: new CommandSafeguard({ maxLines: 3 }) } },
      },
    )
    const { code, out, err } = await runCmd(ws, 'cat /big.txt')
    expect(code).toBe(0)
    expect(out).toBe('line0\nline1\nline2\n')
    expect(err).toContain('truncated')
  })

  it('commandSafeguards constructor option rejects an unknown prefix', () => {
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    expect(
      () =>
        new Workspace(
          { '/': ram },
          {
            mode: MountMode.WRITE,
            ops: registry,
            shellParser: parser,
            commandSafeguards: { '/missing': { cat: new CommandSafeguard({ maxLines: 3 }) } },
          },
        ),
    ).toThrow(/unknown mount prefix/)
  })

  it('onExceed=ERROR drops stdout + exits 1', async () => {
    const ws = buildWs(5)
    overrideSafeguard(ws, 'cat', new CommandSafeguard({ maxLines: 3, onExceed: OnExceed.ERROR }))
    const { code, out, err } = await runCmd(ws, 'cat /big.txt')
    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toContain('truncated')
  })

  it('below limit leaves output untouched', async () => {
    const ws = buildWs(5)
    const { code, out, err } = await runCmd(ws, 'cat /big.txt')
    expect(code).toBe(0)
    expect(out).toBe('line0\nline1\nline2\nline3\nline4\n')
    expect(err).not.toContain('truncated')
  })
})
