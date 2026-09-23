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
import type { EvalStatus, EvalValue, RunArgs } from '../../types.ts'
import type { PyodideInterface } from './loader.ts'
import type { XattrOp } from './vfs/types.ts'

interface PyProxy {
  destroy(): void
  toJs(options: { create_proxies: boolean }): unknown
}

type PyFunction = ((...args: unknown[]) => PyProxy) & PyProxy
interface PyNamespace extends PyProxy {
  get(name: string): PyFunction
}

/**
 * The guest's extended-attribute door, registered as `_mirage_xattr`:
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

type ExecutionRequest = Pick<RunArgs, 'code' | 'env' | 'stdin'> & {
  argv: string[]
  cwd: string
  flags: NonNullable<RunArgs['flags']>
  script_cli: boolean
}

export class PyodideExecution {
  private readonly namespace: PyNamespace

  constructor(
    private readonly pyodide: PyodideInterface,
    xattr: XattrCall = NO_XATTRS,
  ) {
    pyodide.registerJsModule('_mirage_xattr', { call: xattr })
    this.namespace = pyodide.toPy({ __name__: '_mirage_pyodide' }) as PyNamespace
    try {
      pyodide.runPython(source, { globals: this.namespace, filename: 'mirage/execution.py' })
    } catch (error) {
      this.namespace.destroy()
      throw error
    }
  }

  run(
    request: ExecutionRequest,
    arm: () => void,
    disarm: () => void,
  ): [Uint8Array, Uint8Array, number] {
    const [stdout, stderr, exitCode] = this.call(
      'run',
      { ...request, stdin: request.stdin ?? undefined },
      arm,
      disarm,
    ) as [number[], number[], number]
    return [new Uint8Array(stdout), new Uint8Array(stderr), exitCode]
  }

  evaluate(
    code: string,
    inputs: Record<string, EvalValue>,
  ): [string, Uint8Array, Uint8Array, boolean, boolean] {
    const [value, stdout, stderr, ok, syntax] = this.call('evaluate', code, inputs) as [
      string,
      number[],
      number[],
      boolean,
      boolean,
    ]
    return [value, new Uint8Array(stdout), new Uint8Array(stderr), ok, syntax]
  }

  repl(
    code: string,
    session: string,
    inputs: Record<string, EvalValue>,
  ): [Uint8Array, Uint8Array, number, EvalStatus] {
    const [stdout, stderr, exitCode, status] = this.call('repl', code, session, inputs) as [
      number[],
      number[],
      number,
      EvalStatus,
    ]
    return [new Uint8Array(stdout), new Uint8Array(stderr), exitCode, status]
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
    let result: PyProxy | undefined
    try {
      for (const arg of args) converted.push(this.pyodide.toPy(arg))
      // PyProxy calls are synchronous so interpreter interrupts reach guest code.
      result = fn(...converted)
      return result.toJs({ create_proxies: false })
    } finally {
      result?.destroy()
      for (const arg of converted) {
        if (
          arg !== null &&
          (typeof arg === 'object' || typeof arg === 'function') &&
          'destroy' in arg
        )
          (arg as PyProxy).destroy()
      }
      fn.destroy()
    }
  }
}
