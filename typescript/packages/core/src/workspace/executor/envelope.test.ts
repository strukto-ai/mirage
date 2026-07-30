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

import { execFile } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { pythonEvalHarness, splitEnvelope, SENTINEL } from './envelope.ts'
import { EvalError, type EvalValue } from './runtime.ts'

const ENC = new TextEncoder()

function runHarness(
  code: string,
  inputs?: Record<string, EvalValue>,
): Promise<{ stdout: Uint8Array; stderr: string; exitCode: number }> {
  const harness = pythonEvalHarness(code, inputs)
  return new Promise((resolve, reject) => {
    const child = execFile(
      'python3',
      ['-'],
      { encoding: 'buffer' },
      (err, stdout, stderr) => {
        const exitCode =
          err !== null && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code ?? 1)
            : err !== null
              ? 1
              : 0
        if (err !== null && (err as { code?: unknown }).code === undefined) {
          reject(err)
          return
        }
        resolve({
          stdout: new Uint8Array(stdout),
          stderr: new TextDecoder().decode(new Uint8Array(stderr)),
          exitCode,
        })
      },
    )
    child.stdin?.write(harness)
    child.stdin?.end()
  })
}

describe('python eval envelope', () => {
  it('round-trips the last expression and user stdout', async () => {
    const proc = await runHarness("print('side'); ctx['n'] + 1", { ctx: { n: 41 } })
    expect(proc.exitCode).toBe(0)
    const [stdout, value] = splitEnvelope(proc.stdout)
    expect(new TextDecoder().decode(stdout)).toBe('side\n')
    expect(value).toBe(42)
  })

  it('raised code exits nonzero with no envelope', async () => {
    const proc = await runHarness('1 / 0')
    expect(proc.exitCode).toBe(1)
    expect(proc.stderr).toContain('ZeroDivisionError')
    expect(() => splitEnvelope(proc.stdout)).toThrow(/no result envelope/)
  })

  it('non-serializable values fail loud far-side', async () => {
    const proc = await runHarness('set()')
    expect(proc.exitCode).toBe(1)
    expect(proc.stderr).toContain('not JSON-serializable')
  })

  it('user output cannot forge the sentinel', () => {
    // NUL bytes never appear inside JSON text, so a printed sentinel
    // still loses to the harness's own final envelope.
    const stdout = ENC.encode(`fake${SENTINEL}"decoy"${SENTINEL}"real"`)
    const [, value] = splitEnvelope(stdout)
    expect(value).toBe('real')
  })

  it('a bad JSON tail is an EvalError', () => {
    expect(() => splitEnvelope(ENC.encode(`out${SENTINEL}{nope`))).toThrow(EvalError)
  })

  it('non-serializable inputs fail loud host-side', () => {
    const cyclic: Record<string, EvalValue> = {}
    cyclic.self = cyclic
    expect(() => pythonEvalHarness('1', cyclic)).toThrow(/inputs are not JSON-serializable/)
  })
})
