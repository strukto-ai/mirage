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

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  buildVfs,
  Mount,
  MountMode,
  RAMVFS,
  registerVfsFactory,
  Workspace,
} from '@struktoai/mirage-node'

class PortableRAM extends RAMVFS {}

async function check(ws: Workspace, command: string, stdout = ''): Promise<void> {
  const result = await ws.shell(command)
  assert.equal(result.exitCode, 0, `${command}: ${result.stderrText}`)
  assert.equal(result.stderrText, '', command)
  assert.equal(result.stdoutText, stdout, command)
}

async function functions(ws: Workspace, phase: 'write' | 'read'): Promise<void> {
  const corpus = JSON.parse(
    await readFile(new URL('./lifecycle/cases.json', import.meta.url), 'utf8'),
  ) as {
    cases: {
      id: string
      steps: {
        op: string
        command?: string
        expect?: { value: { exit_code: number; stdout: string; stderr: string } }
      }[]
    }[]
  }
  const scenario = corpus.cases.find((c) => c.id === 'function_sources_survive_snapshot_restore')
  assert(scenario)
  const at = scenario.steps.findIndex(
    (step) => step.op === (phase === 'write' ? 'snapshot' : 'checkout'),
  )
  assert(at >= 0)
  const selected = phase === 'write' ? scenario.steps.slice(0, at) : scenario.steps.slice(at + 1)
  for (const step of selected) {
    assert(step.command !== undefined && step.expect !== undefined)
    const command = step.command.replaceAll('/data/', '/direct/')
    const result = await ws.shell(command)
    assert.deepEqual(
      { exit_code: result.exitCode, stdout: result.stdoutText, stderr: result.stderrText },
      step.expect.value,
      command,
    )
  }
}

async function write(path: string): Promise<void> {
  const ws = new Workspace(
    {
      '/direct/': new RAMVFS(),
      '/nested/registered/': new Mount(await buildVfs('portable-ram'), {
        vfsRef: 'portable-ram',
        index: { ttl: 37 },
      }),
    },
    { mode: MountMode.WRITE },
  )
  try {
    await check(ws, "printf 'portable\\n' > /direct/note.txt")
    await check(ws, "printf 'registered\\n' > /nested/registered/note.txt")
    await check(ws, 'ln -s /direct/note.txt /nested/registered/link')
    await functions(ws, 'write')
    await ws.snapshot(path)
  } finally {
    await ws.close()
  }
}

async function read(path: string): Promise<void> {
  const ws = await Workspace.load(path)
  try {
    await check(ws, 'cat /direct/note.txt', 'portable\n')
    await check(ws, 'cat /nested/registered/*.txt', 'registered\n')
    await check(ws, 'cat /nested/registered/link', 'portable\n')
    await functions(ws, 'read')
    const registered = ws.mounts().find((m) => m.prefix === '/nested/registered/')
    assert(registered?.vfs instanceof PortableRAM)
    assert.equal(registered.indexConfig?.ttl, 37)
  } finally {
    await ws.close()
  }
}

registerVfsFactory('portable-ram', () => Promise.resolve(new PortableRAM()))
const [role, path] = process.argv.slice(2)
assert(path !== undefined, 'snapshot path is required')
if (role === 'write') await write(path)
else if (role === 'read') await read(path)
else throw new Error(`unknown role: ${String(role)}`)
