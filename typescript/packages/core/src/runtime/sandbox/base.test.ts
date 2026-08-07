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
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { Limit, MountMode } from '../../types.ts'
import { Workspace } from '../../workspace/workspace.ts'
import { RemoteSandbox } from './base.ts'
import { isLineExecutor } from '../mixin.ts'
import type { RunResult, RuntimeOptions } from '../types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

class RecordingSandbox extends RemoteSandbox {
  readonly name = 'recbox'
  readonly execs: [string, Uint8Array | null, Record<string, string>, string][] = []
  connectedCount = 0

  constructor(options: RuntimeOptions = {}) {
    super(options)
  }

  connect(): Promise<void> {
    this.connectedCount += 1
    return Promise.resolve()
  }

  execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    this.execs.push([line, stdin, env, cwd])
    return Promise.resolve({ stdout: ENC.encode(`ran:${line}`), stderr: null, exitCode: 0 })
  }
}

async function sandboxWorkspace(box: RecordingSandbox): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace(
    { '/data': new RAMResource() },
    {
      mode: MountMode.EXEC,
      shellParser: parser,
      runtimes: [box, 'vfs'],
    },
  )
}

describe('RemoteSandbox', () => {
  it('connects on the first line only', async () => {
    const box = new RecordingSandbox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box)
    try {
      const io = await ws.execute('python3 x')
      expect(DEC.decode(io.stdout)).toBe('ran:python3 x')
      expect(box.connectedCount).toBe(1)
      await ws.execute('python3 x')
      // The runtime connects on the first line, not per line.
      expect(box.connectedCount).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('a failed connect retries on the next line', async () => {
    class FlakyBox extends RecordingSandbox {
      override connect(): Promise<void> {
        this.connectedCount += 1
        if (this.connectedCount === 1) return Promise.reject(new Error('sandbox not running'))
        return Promise.resolve()
      }
    }
    const box = new FlakyBox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box)
    try {
      const first = await ws.execute('python3 x')
      expect(first.exitCode).not.toBe(0)
      expect(DEC.decode(first.stderr)).toContain('not running')
      const second = await ws.execute('python3 x')
      expect(second.exitCode).toBe(0)
      expect(box.connectedCount).toBe(2)
    } finally {
      await ws.close()
    }
  })

  it('passes cwd through verbatim and merges env', async () => {
    const box = new RecordingSandbox({ captures: ['*'], config: { env: { BASE: '1' } } })
    const result = await box.runLine('nvidia-smi', null, { LINE: '2' }, '/data/deep')
    expect(result.exitCode).toBe(0)
    const [, , env, cwd] = box.execs[box.execs.length - 1] ?? [
      '',
      null,
      {} as Record<string, string>,
      '',
    ]
    // The sandbox serves the workspace at the same prefixes as the
    // host, so nothing is rewritten.
    expect(cwd).toBe('/data/deep')
    expect(env.BASE).toBe('1')
    expect(env.LINE).toBe('2')
  })

  it('passes stdin bytes through to execLine', async () => {
    const box = new RecordingSandbox({ captures: ['*'] })
    const ws = await sandboxWorkspace(box)
    try {
      await ws.execute('wc -l', { stdin: ENC.encode('a\nb\n') })
      const [, stdin] = box.execs[box.execs.length - 1] ?? ['', null, {}, '']
      expect(DEC.decode(stdin ?? new Uint8Array())).toBe('a\nb\n')
    } finally {
      await ws.close()
    }
  })

  it('sandboxes take lines, not stages', () => {
    // A sandbox is a line executor, never the engine inside one
    // command: it carries the line door and no interpreter door.
    const box = new RecordingSandbox()
    expect(isLineExecutor(box)).toBe(true)
    expect('run' in box).toBe(false)
  })

  it('a line timeout answers 124', async () => {
    class SlowBox extends RecordingSandbox {
      override async execLine(
        line: string,
        stdin: Uint8Array | null,
        env: Record<string, string>,
        cwd: string,
      ): Promise<RunResult> {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return super.execLine(line, stdin, env, cwd)
      }
    }
    const box = new SlowBox({ captures: ['python3'] })
    const parser = await getTestParser()
    const guards = { python3: new Limit({ timeoutSeconds: 0.05 }) }
    const ws = new Workspace(
      { '/data': [new RAMResource(), MountMode.EXEC, guards] },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: [box, 'vfs'] },
    )
    try {
      // A captured line obeys the same command limits as any
      // command: the mount's python3 timeout answers exit 124.
      const io = await ws.execute('python3 train.py')
      expect(io.exitCode).toBe(124)
      expect(DEC.decode(io.stderr)).toContain('timed out')
    } finally {
      await ws.close()
    }
  })

  it('line output caps truncate with a notice', async () => {
    class ChattyBox extends RecordingSandbox {
      override execLine(): Promise<RunResult> {
        return Promise.resolve({ stdout: ENC.encode('a\nb\nc\n'), stderr: null, exitCode: 0 })
      }
    }
    const box = new ChattyBox({ captures: ['python3'] })
    const parser = await getTestParser()
    const guards = { python3: new Limit({ maxLines: 2 }) }
    const ws = new Workspace(
      { '/data': [new RAMResource(), MountMode.EXEC, guards] },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: [box, 'vfs'] },
    )
    try {
      const io = await ws.execute('python3 train.py')
      expect(io.exitCode).toBe(0)
      expect(DEC.decode(io.stdout)).toBe('a\nb\n')
      expect(DEC.decode(io.stderr)).toContain('truncated at limit')
    } finally {
      await ws.close()
    }
  })

  it('rejects unknown config keys', () => {
    const options = { config: { snapshot: 'mirage-fuse' } } as Record<string, unknown>
    expect(() => new RecordingSandbox(options)).toThrow("unknown runtime config key 'snapshot'")
  })
})
