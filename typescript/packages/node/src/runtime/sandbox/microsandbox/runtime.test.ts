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

import { describe, expect, it, vi } from 'vitest'
import { MountMode, PathSpec } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '../../../workspace.ts'
import { buildRuntime } from '@struktoai/mirage-core/runtime/table'
import { MicrosandboxRuntime } from './runtime.ts'
import * as cli from '../cli.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

describe('MicrosandboxRuntime', () => {
  it.each([
    ['{"status":"Stopped"}', 'not running'],
    ['{"status":"Paused"}', 'not running'],
    ['{"status":"Crashed"}', 'not running'],
    ['{"status":"Draining"}', 'not running'],
    ['{"status":"Starting"}', 'not running'],
    ['{"status":"Created"}', 'not running'],
    ['{"status":"unknown"}', 'not running'],
    ['{}', 'not running'],
    ['null', 'invalid status object'],
    ['[]', 'invalid status object'],
    ['not json', 'unreadable json'],
  ])('refuses unusable status %s before exec', async (status, message) => {
    const invoke = vi.spyOn(cli, 'runCli').mockResolvedValue({
      stdout: ENC.encode(status),
      stderr: new Uint8Array(),
      code: 0,
    })
    try {
      const runtime = buildRuntime('microsandbox', { config: { sandbox: 'box' } })
      await expect(
        runtime.execute({
          kind: 'shell',
          line: 'touch /must-not-exist',
          cwd: PathSpec.fromStrPath('/'),
          env: {},
          stdin: null,
        }),
      ).rejects.toThrow(message)
      expect(invoke).toHaveBeenCalledOnce()
      expect(invoke.mock.calls[0]?.[2]).toEqual(['inspect', 'box', '--format', 'json'])
    } finally {
      invoke.mockRestore()
    }
  })

  it('preserves the inspect CLI error', async () => {
    const invoke = vi.spyOn(cli, 'runCli').mockResolvedValue({
      stdout: new Uint8Array(),
      stderr: ENC.encode('sandbox not found'),
      code: 1,
    })
    try {
      await expect(
        new MicrosandboxRuntime({ config: { sandbox: 'missing' } }).connect(),
      ).rejects.toThrow('sandbox not found')
    } finally {
      invoke.mockRestore()
    }
  })

  it.each(['', '  '])('refuses a blank sandbox name %j', (sandbox) => {
    expect(() => buildRuntime('microsandbox', { config: { sandbox } })).toThrow(
      'microsandbox config needs a nonblank sandbox',
    )
  })

  it('requires a sandbox name and rejects unknown config', () => {
    expect(() => new MicrosandboxRuntime({ config: {} })).toThrow('sandbox')
    expect(() => new MicrosandboxRuntime({ config: { sandbox: 'box', typo: true } })).toThrow(
      'typo',
    )
  })

  it('maps process requests to the msb CLI contract', async () => {
    const invoke = vi
      .spyOn(cli, 'runCli')
      .mockResolvedValueOnce({
        stdout: ENC.encode('{"status":"Running"}'),
        stderr: new Uint8Array(),
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: ENC.encode('output'),
        stderr: ENC.encode('diagnostic'),
        code: 7,
      })
    try {
      const runtime = buildRuntime('microsandbox', {
        config: { sandbox: 'box', env: { MARK: 'config' } },
      })
      const words = ['python3', 'a b', '$(literal)', '', '--flag'] as const
      const input = ENC.encode('input')
      const result = await runtime.execute({
        kind: 'process',
        argv: words,
        cwd: PathSpec.fromStrPath('/work'),
        env: { MARK: 'request' },
        stdin: input,
      })
      expect(
        invoke.mock.calls.map(([executable, _hint, args, stdin]) => [executable, args, stdin]),
      ).toEqual([
        ['msb', ['inspect', 'box', '--format', 'json'], null],
        [
          'msb',
          [
            'exec',
            'box',
            '--quiet',
            '--no-tty',
            '-w',
            '/work',
            '-e',
            'MARK=request',
            '--',
            ...words,
          ],
          input,
        ],
      ])
      expect(DEC.decode(result.stdout)).toBe('output')
      expect(DEC.decode(result.stderr)).toBe('diagnostic')
      expect(result.exitCode).toBe(7)
    } finally {
      invoke.mockRestore()
    }
  })
})

const SANDBOX = process.env.MIRAGE_INTEG_MICROSANDBOX_SANDBOX
const STOPPED_SANDBOX = process.env.MIRAGE_INTEG_MICROSANDBOX_STOPPED_SANDBOX

it.skipIf(!STOPPED_SANDBOX)('does not start a real stopped guest', async () => {
  const runtime = new MicrosandboxRuntime({ config: { sandbox: STOPPED_SANDBOX } })
  await expect(
    runtime.execute({
      kind: 'shell',
      line: 'echo must-not-run',
      cwd: PathSpec.fromStrPath('/'),
      env: {},
      stdin: null,
    }),
  ).rejects.toThrow('status: Stopped')
  await expect(
    new MicrosandboxRuntime({ config: { sandbox: STOPPED_SANDBOX } }).connect(),
  ).rejects.toThrow('status: Stopped')
})

describe.skipIf(!SANDBOX)('MicrosandboxRuntime real guest', () => {
  it('preserves process and shell I/O and reads/writes guest Mirage FUSE', async () => {
    const runtime = buildRuntime('microsandbox', {
      config: { sandbox: SANDBOX, env: { MARK: 'config' } },
    })
    expect(runtime).toBeInstanceOf(MicrosandboxRuntime)
    const cwd = PathSpec.fromStrPath('/data')
    const payload = new Uint8Array([105, 110, 112, 117, 116, 0, 255, 13, 10])
    const words = ['a b', '$(echo literal)', '', '--flag']
    const result = await runtime.execute({
      kind: 'process',
      argv: [
        'python3',
        '-c',
        'import json,os,sys; sys.stdout.buffer.write(sys.stdin.buffer.read()); ' +
          "sys.stderr.write(json.dumps([os.getcwd(),os.environ['MARK'],sys.argv[1:]])); sys.exit(7)",
        ...words,
      ],
      cwd,
      env: { MARK: 'request' },
      stdin: payload,
    })
    expect(result.stdout).toEqual(payload)
    expect(JSON.parse(DEC.decode(result.stderr))).toEqual(['/data', 'request', words])
    expect(result.exitCode).toBe(7)
    const shell = await runtime.execute({
      kind: 'shell',
      line: 'printf "%s" "$MARK"; pwd',
      cwd,
      env: {},
      stdin: null,
    })
    expect(DEC.decode(shell.stdout)).toBe('config/data\n')
    expect(DEC.decode(shell.stderr)).toBe('')
    expect(shell.exitCode).toBe(0)
    const files = await runtime.execute({
      kind: 'process',
      argv: [
        'python3',
        '-c',
        'from pathlib import Path; ' +
          "assert any(' /data fuse ' in line for line in Path('/proc/mounts').read_text().splitlines()); " +
          "assert Path('hello.txt').read_text() == 'hello from Mirage FUSE\\n'; " +
          "Path('typescript.txt').write_text('typescript adapter\\n'); " +
          "assert Path('typescript.txt').read_text() == 'typescript adapter\\n'; " +
          "print('Mirage FUSE read/write passed')",
      ],
      cwd,
      env: {},
      stdin: null,
    })
    expect(DEC.decode(files.stdout)).toBe('Mirage FUSE read/write passed\n')
    expect(DEC.decode(files.stderr)).toBe('')
    expect(files.exitCode).toBe(0)
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        runtimes: [
          new MicrosandboxRuntime({
            captures: ['python3', '@external'],
            config: { sandbox: SANDBOX },
          }),
          'workspace',
        ],
      },
    )
    try {
      const routed = await ws.shell(
        `python3 -c 'from pathlib import Path; print(Path("/data/typescript.txt").read_text(), end="")'`,
      )
      expect(DEC.decode(routed.stdout)).toBe('typescript adapter\n')
      expect(DEC.decode(routed.stderr)).toBe('')
      expect(routed.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
    await runtime.close()
    await new MicrosandboxRuntime({ config: { sandbox: SANDBOX } }).connect()
  }, 60_000)
})
