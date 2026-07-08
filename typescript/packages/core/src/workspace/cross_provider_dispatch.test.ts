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
import { RegisteredCommand } from '../commands/config.ts'
import { CommandSpec, Operand, OperandKind } from '../commands/spec/types.ts'
import { IOResult } from '../io/types.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { ProvisionResult } from '../provision/types.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode, ResourceName } from '../types.ts'
import { getTestParser, stderrStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()
const SPEC = new CommandSpec({ rest: new Operand({ kind: OperandKind.PATH }) })

const noopFn = (): Promise<[Uint8Array, IOResult]> =>
  Promise.resolve([ENC.encode('ok'), new IOResult()])

const noopProvision = (): Promise<ProvisionResult> =>
  Promise.resolve(
    new ProvisionResult({
      command: 'noop',
      networkReadLow: 10,
      networkReadHigh: 10,
      readOps: 1,
    }),
  )

async function makeWs(mounts: Record<string, RAMResource>): Promise<Workspace> {
  const parser = await getTestParser()
  const registry = new OpsRegistry()
  for (const r of Object.values(mounts)) registry.registerResource(r)
  return new Workspace(mounts, { mode: MountMode.WRITE, ops: registry, shellParser: parser })
}

function seed(r: RAMResource, path: string, content: string): void {
  r.store.files.set(path, ENC.encode(content))
}

function registerOnAll(ws: Workspace, prefixes: string[], rc: RegisteredCommand): void {
  for (const p of prefixes) {
    const mount = ws.registry.mountForPrefix(p)
    if (mount === null) throw new Error(`mount missing: ${p}`)
    mount.register(rc)
  }
}

describe('cross-resource dispatch (port of test_cross_provider_dispatch.py)', () => {
  it('no-aggregate cross-mount returns exit 1 with "cross-mount not supported"', async () => {
    const m1 = new RAMResource()
    const m2 = new RAMResource()
    seed(m1, '/a.txt', 'aaa\n')
    seed(m2, '/b.txt', 'bbb\n')
    const ws = await makeWs({ '/m1': m1, '/m2': m2 })
    const rc = new RegisteredCommand({
      name: 'nocross',
      spec: SPEC,
      resource: ResourceName.RAM,
      fn: noopFn,
    })
    registerOnAll(ws, ['/m1', '/m2'], rc)
    const io = await ws.execute('nocross /m1/a.txt /m2/b.txt')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('cross-mount not supported')
    await ws.close()
  })

  it('cross-mount error names the mount prefixes in stderr', async () => {
    const m1 = new RAMResource()
    const m2 = new RAMResource()
    seed(m1, '/a.txt', 'aaa\n')
    seed(m2, '/b.txt', 'bbb\n')
    const ws = await makeWs({ '/m1': m1, '/m2': m2 })
    const rc = new RegisteredCommand({
      name: 'nocross',
      spec: SPEC,
      resource: ResourceName.RAM,
      fn: noopFn,
    })
    registerOnAll(ws, ['/m1', '/m2'], rc)
    const io = await ws.execute('nocross /m1/a.txt /m2/b.txt')
    const err = stderrStr(io)
    expect(err).toContain('/m1')
    expect(err).toContain('/m2')
    await ws.close()
  })

  it('cat (aggregate) across two mounts works', async () => {
    const m1 = new RAMResource()
    const m2 = new RAMResource()
    seed(m1, '/a.txt', 'aaa\n')
    seed(m2, '/b.txt', 'bbb\n')
    const ws = await makeWs({ '/m1': m1, '/m2': m2 })
    const io = await ws.execute('cat /m1/a.txt /m2/b.txt')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('glob operands expand per mount in operand order', async () => {
    const m1 = new RAMResource()
    const m2 = new RAMResource()
    seed(m1, '/a.txt', 'r1\nr2\n')
    seed(m1, '/b.txt', 'r3\n')
    seed(m2, '/c.txt', 'd1\n')
    const ws = await makeWs({ '/m1': m1, '/m2': m2 })
    const io = await ws.execute('cat /m1/*.txt /m2/*.txt')
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(io.stdout)).toBe('r1\nr2\nr3\nd1\n')
    await ws.close()
  })

  it('cat -n numbers continuously across expanded mounts', async () => {
    const m1 = new RAMResource()
    const m2 = new RAMResource()
    seed(m1, '/a.txt', 'r1\nr2\n')
    seed(m2, '/c.txt', 'd1\n')
    const ws = await makeWs({ '/m1': m1, '/m2': m2 })
    const io = await ws.execute('cat -n /m1/*.txt /m2/*.txt')
    expect(io.exitCode).toBe(0)
    const out = new TextDecoder().decode(io.stdout)
    expect(out).toContain('1\tr1')
    expect(out).toContain('3\td1')
    await ws.close()
  })

  it('wc totals across expanded mounts', async () => {
    const m1 = new RAMResource()
    const m2 = new RAMResource()
    seed(m1, '/a.txt', 'r1\nr2\n')
    seed(m2, '/c.txt', 'd1\n')
    const ws = await makeWs({ '/m1': m1, '/m2': m2 })
    const io = await ws.execute('wc -l /m1/*.txt /m2/*.txt')
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(io.stdout)).toContain('3 total')
    await ws.close()
  })

  it('zero-match glob keeps the literal and fails like GNU', async () => {
    const m1 = new RAMResource()
    const m2 = new RAMResource()
    seed(m1, '/a.txt', 'r1\n')
    seed(m2, '/c.txt', 'd1\n')
    const ws = await makeWs({ '/m1': m1, '/m2': m2 })
    const io = await ws.execute('cat /m1/*.nope /m2/*.txt')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io)).toContain('/m1/*.nope')
    await ws.close()
  })

  it('no-aggregate with single mount still succeeds', async () => {
    const m1 = new RAMResource()
    const m2 = new RAMResource()
    seed(m1, '/a.txt', 'aaa\n')
    seed(m2, '/b.txt', 'bbb\n')
    const ws = await makeWs({ '/m1': m1, '/m2': m2 })
    const rc = new RegisteredCommand({
      name: 'nocross',
      spec: SPEC,
      resource: ResourceName.RAM,
      fn: noopFn,
    })
    registerOnAll(ws, ['/m1', '/m2'], rc)
    const io = await ws.execute('nocross /m1/a.txt')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('three-mount cross-resource still errors', async () => {
    const m1 = new RAMResource()
    const m2 = new RAMResource()
    const m3 = new RAMResource()
    seed(m1, '/a.txt', 'a')
    seed(m2, '/b.txt', 'b')
    seed(m3, '/c.txt', 'c')
    const ws = await makeWs({ '/m1': m1, '/m2': m2, '/m3': m3 })
    const rc = new RegisteredCommand({
      name: 'nocross',
      spec: SPEC,
      resource: ResourceName.RAM,
      fn: noopFn,
    })
    registerOnAll(ws, ['/m1', '/m2', '/m3'], rc)
    const io = await ws.execute('nocross /m1/a.txt /m2/b.txt /m3/c.txt')
    expect(io.exitCode).toBe(1)
    const err = stderrStr(io)
    expect(err.includes('/m1') || err.includes('/m2') || err.includes('/m3')).toBe(true)
    await ws.close()
  })

  it('plan (provision) cross-mount single-mount returns ProvisionResult', async () => {
    const m1 = new RAMResource()
    const m2 = new RAMResource()
    seed(m1, '/a.txt', 'a')
    seed(m2, '/b.txt', 'b')
    const ws = await makeWs({ '/m1': m1, '/m2': m2 })
    const rc = new RegisteredCommand({
      name: 'nocross',
      spec: SPEC,
      resource: ResourceName.RAM,
      fn: noopFn,
      provisionFn: noopProvision,
    })
    registerOnAll(ws, ['/m1', '/m2'], rc)
    const result = await ws.execute('nocross /m1/a.txt', { provision: true })
    expect(result).toBeInstanceOf(ProvisionResult)
    if (!(result instanceof ProvisionResult)) throw new Error('expected ProvisionResult')
    expect(result.networkReadLow).toBe(10)
    await ws.close()
  })

  it('aggregate partial failure propagates non-zero exit code and writes stderr', async () => {
    const m1 = new RAMResource()
    const m2 = new RAMResource()
    seed(m1, '/a.txt', 'aaa\n')
    const ws = await makeWs({ '/m1': m1, '/m2': m2 })
    const io = await ws.execute('cat /m1/a.txt /m2/missing.txt')
    expect(io.exitCode).not.toBe(0)
    expect(stderrStr(io).length).toBeGreaterThan(0)
    await ws.close()
  })

  it('aggregate all-succeed exits 0', async () => {
    const m1 = new RAMResource()
    const m2 = new RAMResource()
    seed(m1, '/a.txt', 'aaa\n')
    seed(m2, '/b.txt', 'bbb\n')
    const ws = await makeWs({ '/m1': m1, '/m2': m2 })
    const io = await ws.execute('cat /m1/a.txt /m2/b.txt')
    expect(io.exitCode).toBe(0)
    await ws.close()
  })
})
