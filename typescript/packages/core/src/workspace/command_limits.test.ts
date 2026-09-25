import { CLISpec } from '../commands/cli/types.ts'
import { IOResult } from '../io/types.ts'
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

import { SessionState } from './session/session.ts'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse/index.ts'
import { Limit, MountMode, OnExceed } from '../types.ts'
import { Mount } from './mount/spec.ts'
import { Workspace } from './workspace/workspace.ts'

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
  const ram = new RAMVFS()
  const registry = new OpsRegistry()
  registry.registerVfs(ram)
  const body = Array.from({ length: nLines }, (_, i) => `line${String(i)}\n`).join('')
  ram.store.files.set('/big.txt', ENC.encode(body))
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops: registry, shellParser: parser })
}

function overrideLimit(ws: Workspace, name: string, sg: Limit): void {
  for (const m of ws.registry.allMounts()) m.commandLimits.set(name, sg)
}

async function runCmd(
  ws: Workspace,
  cmd: string,
): Promise<{ code: number; out: string; err: string }> {
  try {
    const res = await ws.shell(cmd)
    return { code: res.exitCode, out: DEC.decode(res.stdout), err: DEC.decode(res.stderr) }
  } finally {
    await ws.close()
  }
}

describe('Workspace command limit', () => {
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
    overrideLimit(ws, 'cat', new Limit({ maxLines: 3 }))
    const { code, out, err } = await runCmd(ws, 'cat /big.txt')
    expect(code).toBe(0)
    expect(out).toBe('line0\nline1\nline2\n')
    expect(err).toContain('truncated')
  })

  it('commandLimits constructor option caps below default', async () => {
    const ram = new RAMVFS()
    const registry = new OpsRegistry()
    registry.registerVfs(ram)
    ram.store.files.set('/big.txt', ENC.encode('line0\nline1\nline2\nline3\nline4\n'))
    const ws = new Workspace(
      { '/': ram },
      {
        mode: MountMode.WRITE,
        ops: registry,
        shellParser: parser,
        commandLimits: { cat: new Limit({ maxLines: 3 }) },
      },
    )
    const { code, out, err } = await runCmd(ws, 'cat /big.txt')
    expect(code).toBe(0)
    expect(out).toBe('line0\nline1\nline2\n')
    expect(err).toContain('truncated')
  })

  it.each([
    [
      'a Mount',
      (ram: RAMVFS, limits: Record<string, Limit>) => new Mount(ram, { commandLimits: limits }),
    ],
    ['a tuple', (ram: RAMVFS, limits: Record<string, Limit>) => [ram, MountMode.WRITE, limits]],
  ])('merges %s over the workspace-level limits per command', (_name, spell) => {
    // The two sources used to be spread one whole record over the
    // other, so whichever lost dropped every command it named: the
    // workspace-level `ls` limit here vanished the moment the mount
    // declared a `cat` one. Python reaches the merged shape through
    // `entry.command_limits.update()`.
    const ram = new RAMVFS()
    const registry = new OpsRegistry()
    registry.registerVfs(ram)
    const ws = new Workspace(
      { '/': spell(ram, { cat: new Limit({ maxLines: 3 }) }) as never },
      {
        mode: MountMode.WRITE,
        ops: registry,
        shellParser: parser,
        commandLimits: { cat: new Limit({ maxLines: 9 }), ls: new Limit({ maxLines: 7 }) },
      },
    )
    const mount = ws.registry.mountForPrefix('/')
    // The mount's own declaration wins, as it does for `mode` and `read`.
    expect(mount.commandLimits.get('cat')?.maxLines).toBe(3)
    expect(ws.registry.commandLimits.ls?.maxLines).toBe(7)
  })

  it('onExceed=ERROR drops stdout + exits 1', async () => {
    const ws = buildWs(5)
    overrideLimit(ws, 'cat', new Limit({ maxLines: 3, onExceed: OnExceed.ERROR }))
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

it.each([
  ['seq 1 5; echo end | head -1', '1\n2\n3\n4\n5\nend\n', false],
  ['cat /data/n; echo end', '1\n2\nend\n', true],
  ['cat /data/n | wc -l', '5\n', false],
  ['cat /data/n | head -n 4', '1\n2\n3\n', true],
  ['head -n 3 /data/n', '1\n2\n3\n', false],
  ['{ cat /data/n; echo end; }', '1\n2\nend\n', true],
  ['f(){ cat /data/n; echo end; }; f', '1\n2\nend\n', true],
  ['{ cat /data/n; echo end; } | wc -l', '6\n', false],
  ['cat /data/n > /data/out; wc -l < /data/out', '5\n', false],
  ['{ cat /data/n; echo end; } > /data/out; wc -l < /data/out', '6\n', false],
  ['( cat /data/n; echo end )', '1\n2\nend\n', true],
  ['cat /data/n | { head -n 4; echo end; }', '1\n2\n3\nend\n', true],
  ['grep absent /data/n || echo missing', 'missing\n', false],
])('output boundary: %s', async (command, expected, truncated) => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      shellParser: parser,
      commandLimits: {
        cat: new Limit({ maxLines: 2 }),
        head: new Limit({ maxLines: 3 }),
        grep: new Limit({ maxLines: 2 }),
      },
    },
  )
  try {
    await ws.shell('seq 1 5 > /data/n')
    const result = await ws.shell(command)
    expect(DEC.decode(result.stdout)).toBe(expected)
    expect(DEC.decode(result.stderr).includes('truncated')).toBe(truncated)
    expect(result.exitCode).toBe(0)
  } finally {
    await ws.close()
  }
})

it.each([
  ['cat /data/n && echo success', '', 1],
  ['cat /data/n || echo recovery', 'recovery\n', 0],
  ['cat /data/n; echo $?', '1\n', 0],
  ['seq 1 5 | cat; echo ${PIPESTATUS[@]}', '0 1\n', 0],
] as const)('error limit before control flow: %s', async (command, expected, code) => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      shellParser: parser,
      commandLimits: { cat: new Limit({ maxLines: 2, onExceed: OnExceed.ERROR }) },
    },
  )
  try {
    await ws.shell('seq 1 5 > /data/n')
    const result = await ws.shell(command)
    expect(DEC.decode(result.stdout)).toBe(expected)
    expect(result.exitCode).toBe(code)
    expect(DEC.decode(result.stderr)).toContain('cat: output truncated')
  } finally {
    await ws.close()
  }
})

it('keeps profile limits on the session across storage and forks', async () => {
  const ws = new Workspace(
    { '/data': [new RAMVFS(), MountMode.EXEC, { head: new Limit({ maxLines: 1 }) }] },
    {
      shellParser: parser,
      commandLimits: { head: new Limit({ maxLines: 3 }) },
      profiles: {
        small: { commandLimits: { head: new Limit({ maxLines: 2 }) } },
        large: { commandLimits: { head: new Limit({ maxLines: null }) } },
      },
    },
  )
  try {
    await ws.shell('seq 1 5 > /data/n')
    const small = ws.createSession('small', { profile: 'small' })
    ws.createSession('large', { profile: 'large' })
    for (const [sessionId, count] of [
      [undefined, 3],
      ['small', 2],
      ['large', 4],
    ] as const) {
      const result = await ws.shell(
        'cat /data/n | head -n 4',
        sessionId === undefined ? {} : { sessionId },
      )
      expect(DEC.decode(result.stdout).trim().split('\n')).toHaveLength(count)
    }
    const result = await ws.shell('head -n 4 /data/n', { sessionId: 'large' })
    expect(DEC.decode(result.stdout).trim().split('\n')).toHaveLength(4)
    const restored = SessionState.fromJSON({ ...small.toJSON(), session_id: small.sessionId })
    expect(restored.commandLimits.head?.maxLines).toBe(2)
    expect(restored.fork().commandLimits.head?.maxLines).toBe(2)
    expect(small.toJSON()).not.toHaveProperty('terminalOutput')
  } finally {
    await ws.close()
  }
})

it('lets a profile raise the workspace timeout', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      shellParser: parser,
      commandLimits: { sleep: new Limit({ timeoutSeconds: 0.005 }) },
      profiles: { relaxed: { commandLimits: { sleep: new Limit({ timeoutSeconds: 1 }) } } },
    },
  )
  try {
    ws.createSession('relaxed', { profile: 'relaxed' })
    expect((await ws.shell('sleep .02')).exitCode).toBe(124)
    expect((await ws.shell('sleep .02', { sessionId: 'relaxed' })).exitCode).toBe(0)
  } finally {
    await ws.close()
  }
})

it('applies workspace and profile deadlines to registered CLIs', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    {
      shellParser: parser,
      commandLimits: { prog: new Limit({ timeoutSeconds: 1 }) },
      profiles: { short: { commandLimits: { prog: new Limit({ timeoutSeconds: 0.01 }) } } },
    },
  )
  const spec = new CLISpec({
    name: 'prog',
    limit: new Limit({ timeoutSeconds: 0.01 }),
    fn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return [null, new IOResult()]
    },
  })
  try {
    ws.registerCli('prog', spec)
    ws.createSession('short', { profile: 'short' })
    expect((await ws.shell('prog')).exitCode).toBe(0)
    expect((await ws.shell('prog', { sessionId: 'short' })).exitCode).toBe(124)
  } finally {
    await ws.close()
  }
})
