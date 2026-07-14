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
import type { ExecuteResult } from './workspace.ts'
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

describe('cross-mount strategies (STREAM/FANOUT) end to end', () => {
  const dec = (io: ExecuteResult): string => io.stdoutText

  async function twoMounts(): Promise<Workspace> {
    const m1 = new RAMResource()
    const m2 = new RAMResource()
    seed(m1, '/a.txt', 'r2\nr1\n')
    seed(m1, '/b.txt', 'r3\n')
    seed(m2, '/c.txt', 'd1\n')
    seed(m2, '/d.log', 'log r1\n')
    return makeWs({ '/m1': m1, '/m2': m2 })
  }

  it('sort orders one merged stream across mounts', async () => {
    const ws = await twoMounts()
    const io = await ws.execute('sort /m1/a.txt /m2/c.txt')
    expect(io.exitCode).toBe(0)
    expect(dec(io)).toBe('d1\nr1\nr2\n')
    await ws.close()
  })

  it('cat -n numbers continuously across mounts and globs', async () => {
    const ws = await twoMounts()
    const io = await ws.execute('cat -n /m1/*.txt /m2/c.txt')
    expect(io.exitCode).toBe(0)
    const out = dec(io)
    expect(out).toContain('1\tr2')
    expect(out).toContain('4\td1')
    await ws.close()
  })

  it('nl and cut and sed stream across mounts', async () => {
    const ws = await twoMounts()
    expect(dec(await ws.execute('nl /m1/b.txt /m2/c.txt'))).toContain('2\td1')
    expect(dec(await ws.execute('cut -c1 /m1/b.txt /m2/c.txt'))).toBe('r\nd\n')
    expect(dec(await ws.execute('sed s/r/x/ /m1/b.txt /m2/c.txt'))).toBe('x3\nd1\n')
    await ws.close()
  })

  it('grep fans out with filenames and any-match exit', async () => {
    const ws = await twoMounts()
    const io = await ws.execute('grep r1 /m1/a.txt /m2/d.log')
    expect(io.exitCode).toBe(0)
    expect(dec(io)).toBe('/m1/a.txt:r1\n/m2/d.log:log r1\n')
    const miss = await ws.execute('grep zzz /m1/a.txt /m2/c.txt')
    expect(miss.exitCode).toBe(1)
    await ws.close()
  })

  it('wc re-totals across mounts and globs', async () => {
    const ws = await twoMounts()
    const io = await ws.execute('wc -l /m1/*.txt /m2/c.txt')
    expect(dec(io)).toBe('2 /m1/a.txt\n1 /m1/b.txt\n1 /m2/c.txt\n4 total\n')
    await ws.close()
  })

  it('head shows headers per operand across mounts', async () => {
    const ws = await twoMounts()
    const out = dec(await ws.execute('head -n 1 /m1/a.txt /m2/c.txt'))
    expect(out).toBe('==> /m1/a.txt <==\nr2\n\n==> /m2/c.txt <==\nd1\n')
    await ws.close()
  })

  it('sha256sum and stat and file concatenate per operand', async () => {
    const ws = await twoMounts()
    const io = await ws.execute('sha256sum /m1/a.txt /m2/c.txt')
    expect(io.exitCode).toBe(0)
    const out = dec(io)
    expect(out).toContain('/m1/a.txt')
    expect(out).toContain('/m2/c.txt')
    expect((await ws.execute('file /m1/a.txt /m2/c.txt')).exitCode).toBe(0)
    expect((await ws.execute('stat /m1/a.txt /m2/c.txt')).exitCode).toBe(0)
    await ws.close()
  })

  it('write commands fan out per operand mount', async () => {
    const ws = await twoMounts()
    expect((await ws.execute('touch /m1/n1.txt /m2/n2.txt')).exitCode).toBe(0)
    expect((await ws.execute('mkdir /m1/d1 /m2/d2')).exitCode).toBe(0)
    expect((await ws.execute('rm /m1/n1.txt /m2/n2.txt')).exitCode).toBe(0)
    const tee = await ws.execute('echo hi | tee /m1/t.txt /m2/t.txt')
    expect(tee.exitCode).toBe(0)
    expect(dec(tee)).toBe('hi\n')
    expect(dec(await ws.execute('cat /m1/t.txt /m2/t.txt'))).toBe('hi\nhi\n')
    await ws.close()
  })

  it('sed -i edits each operand in place across mounts', async () => {
    const ws = await twoMounts()
    const io = await ws.execute('sed -i s/r1/z1/ /m1/a.txt /m2/d.log')
    expect(io.exitCode).toBe(0)
    expect(dec(await ws.execute('cat /m1/a.txt /m2/d.log'))).toBe('r2\nz1\nlog z1\n')
    await ws.close()
  })

  it('find fans out per root across mounts', async () => {
    const ws = await twoMounts()
    const io = await ws.execute("find /m1 /m2 -name '*.txt'")
    expect(io.exitCode).toBe(0)
    expect(dec(io)).toBe('/m1/a.txt\n/m1/b.txt\n/m2/c.txt\n')
    await ws.close()
  })

  it('unsupported multi-stream commands still refuse cleanly', async () => {
    const ws = await twoMounts()
    const io = await ws.execute('uniq /m1/a.txt /m2/c.txt')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('cross-mount not supported')
    await ws.close()
  })
})
