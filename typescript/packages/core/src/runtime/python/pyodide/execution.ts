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

import source from '../../../generated/pyodide.ts'
import type { FlagValue } from '../../../commands/spec/types.ts'
import type { PyodideInterface } from './loader.ts'
import type { XattrOp } from './fs/types.ts'
import { concat } from '../../../utils/bytes.ts'

interface PyProxy {
  destroy(): void
  toJs(options: { create_proxies: boolean }): unknown
}

type PyFunction = ((...args: unknown[]) => unknown) & PyProxy

function isProxy(value: unknown): value is PyProxy {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'destroy' in value
  )
}
interface PyNamespace extends PyProxy {
  get(name: string): PyFunction
}

/**
 * The guest's extended-attribute entry point, registered as `_mirage_xattr`:
 * the op, the absolute path, the name and base64 value where the op has
 * them, the create/replace flags and nofollow, answered as JSON (`{value}`,
 * or `{code}` naming the condition).
 */
export type XattrCall = (
  op: XattrOp,
  path: string,
  name: string | null | undefined,
  value: string | null | undefined,
  create: boolean,
  replace: boolean,
  nofollow: boolean,
) => string

const NO_XATTRS: XattrCall = () => JSON.stringify({ code: 'ENOTSUP' })

/**
 * The run's standard streams as the guest's own stdio reaches them,
 * registered as `_mirage_stdio`.
 */
export interface GuestStdio {
  /** One read(2) of the run's input: what has arrived, up to `size` bytes; empty at its end. */
  read(size: number): Uint8Array
  /** Hand one write to stdout (1) or stderr (2): false once its reader has gone. */
  write(fd: 1 | 2, bytes: Uint8Array): boolean
}

/** Streams over a run's whole input that keep what it writes. */
function collected(
  stdin: Uint8Array | null,
): GuestStdio & { out: Uint8Array[]; err: Uint8Array[] } {
  const input = stdin ?? new Uint8Array()
  const out: Uint8Array[] = []
  const err: Uint8Array[] = []
  let at = 0
  return {
    out,
    err,
    read: (size) => {
      const bytes = input.subarray(at, Math.min(input.length, at + size))
      at += bytes.length
      return bytes
    },
    write: (fd, bytes) => {
      ;(fd === 1 ? out : err).push(bytes)
      return true
    },
  }
}

interface ExecutionRequest {
  code: string
  env: Record<string, string>
  // The run's whole input, where its streams are not given.
  stdin: Uint8Array | null
  // Whether the run has input at all; by default, whether `stdin` holds it.
  piped?: boolean
  argv: string[]
  cwd: string
  // The run's interpreter switches (`ctx.flags`).
  flags: Readonly<Record<string, FlagValue>>
  script_cli: boolean
  // What CPython names the program (mainFilename), null for none.
  filename: string | null
  // Whether the program was read from a script file.
  script: boolean
}

export class PyodideExecution {
  private readonly namespace: PyNamespace
  private stdio: GuestStdio = collected(null)

  constructor(
    private readonly pyodide: PyodideInterface,
    xattr: XattrCall = NO_XATTRS,
    subprocess: (payload: string) => string = () => {
      throw new Error('subprocess requires a Pyodide worker with shared memory')
    },
    seal: () => void = () => undefined,
  ) {
    pyodide.registerJsModule('_mirage_xattr', { call: xattr })
    pyodide.registerJsModule('_mirage_process', { run: subprocess })
    pyodide.registerJsModule('_mirage_exit', { seal })
    // Numbers cross, not buffers: Pyodide's buffer conversion slices with
    // signed wasm32 addresses, so above 2 GiB it reads the wrong bytes.
    pyodide.registerJsModule('_mirage_stdio', {
      read: (size: number) => Array.from(this.stdio.read(size)),
      write: (fd: number, data: number[]) =>
        this.stdio.write(fd === 2 ? 2 : 1, Uint8Array.from(data)) ? 0 : -1,
    })
    this.namespace = pyodide.toPy({ __name__: '_mirage_pyodide' }) as PyNamespace
    try {
      pyodide.runPython(source, { globals: this.namespace, filename: 'mirage/execution.py' })
    } catch (error) {
      this.namespace.destroy()
      throw error
    }
  }

  /**
   * Run one program. Its output comes back in the result, or, where the
   * run's streams are given, goes to them as it is written and the
   * result leaves it out.
   *
   * @param request the program and what of the run's context it reads.
   * @param arm starts the run's interrupt countdown.
   * @param disarm stops it.
   * @param stdio the run's streams; absent reads `request.stdin`.
   */
  run(
    request: ExecutionRequest,
    arm: () => void,
    disarm: () => void,
    stdio?: GuestStdio,
  ): [Uint8Array, Uint8Array, number] {
    const kept = collected(request.stdin)
    this.stdio = stdio ?? kept
    try {
      const { stdin, ...rest } = request
      const exitCode = this.call(
        'run',
        {
          ...rest,
          piped: request.piped ?? stdin !== null,
          filename: request.filename ?? undefined,
        },
        arm,
        disarm,
      ) as number
      return [concat(kept.out), concat(kept.err), exitCode]
    } finally {
      this.stdio = collected(null)
    }
  }

  seedSysPath(paths: readonly string[]): string[] {
    return this.call('seed_sys_path', paths) as string[]
  }

  close(): void {
    this.namespace.destroy()
  }

  private call(name: string, ...args: unknown[]): unknown {
    const fn = this.namespace.get(name)
    const converted: unknown[] = []
    // A number or a string comes back as itself, anything else a proxy.
    let result: unknown
    try {
      for (const arg of args) converted.push(this.pyodide.toPy(arg))
      // PyProxy calls are synchronous so interpreter interrupts reach guest code.
      result = fn(...converted)
      return isProxy(result) ? result.toJs({ create_proxies: false }) : result
    } finally {
      if (isProxy(result)) result.destroy()
      for (const arg of converted) if (isProxy(arg)) arg.destroy()
      fn.destroy()
    }
  }
}
