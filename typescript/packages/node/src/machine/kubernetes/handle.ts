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

import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { requireId } from '@struktoai/mirage-core/machine/config'
import { notRunningHint, wrapLine } from '@struktoai/mirage-core/machine/constants'
import { ConnectionLostError } from '@struktoai/mirage-core/machine/errors'
import { registerMachine } from '@struktoai/mirage-core/machine/registry'
import type { MachinePipe } from '@struktoai/mirage-core/machine/types'
import type { ConfigFields } from '@struktoai/mirage-core/runtime/config'
import type { OutputFn, RunResult } from '@struktoai/mirage-core/runtime/types'
import { openProgramPipe, reportedState } from '../program.ts'
import { ProgramMachine } from '../transport.ts'
import { KUBERNETES_CONFIG_FIELDS, type KubernetesConfig } from './config.ts'
import {
  EXIT_PREFIX,
  EXIT_STATUS,
  emptyStdin,
  KUBECTL_HINT,
  ownStdin,
  RUNNING_PHASE,
} from './constants.ts'

/**
 * Where kubectl's report of the exit status can begin in the stderr so
 * far, or its length when it cannot be there. The report follows the
 * program's last byte directly, on a line of its own or not.
 *
 * @param stderr the stderr not yet passed on.
 */
export function exitReportStart(stderr: Buffer): number {
  const at = stderr.lastIndexOf(EXIT_PREFIX)
  if (at >= 0 && EXIT_STATUS.test(stderr.subarray(at + EXIT_PREFIX.length).toString('latin1'))) {
    return at
  }
  const size = stderr.length
  for (let start = Math.max(0, size - EXIT_PREFIX.length + 1); start < size; start++) {
    if (EXIT_PREFIX.subarray(0, size - start).equals(stderr.subarray(start))) return start
  }
  return size
}

/**
 * kubectl's stderr with its own report of the exit status taken out, so
 * a failing program says only what it said itself.
 *
 * The report comes last, so only an ending that can still become one is
 * held; everything else passes as it arrives.
 */
export class ExitLineFilter {
  private readonly errors: OutputFn | null
  private held: Buffer = Buffer.alloc(0)
  private readonly chunks: Uint8Array[] = []

  /** @param errors receives stderr as it arrives; null keeps it for `kept`. */
  constructor(errors: OutputFn | null) {
    this.errors = errors
  }

  /** The stderr kept when nothing receives it, null for none. */
  get kept(): Uint8Array | null {
    return this.chunks.length > 0 ? Buffer.concat(this.chunks) : null
  }

  private async emit(data: Uint8Array): Promise<void> {
    if (data.length === 0) return
    if (this.errors === null) this.chunks.push(data)
    else await this.errors(data)
  }

  /**
   * Pass on what cannot be the report.
   *
   * @param data the next bytes of stderr.
   */
  async write(data: Uint8Array): Promise<void> {
    const held = Buffer.concat([this.held, data])
    const end = exitReportStart(held)
    this.held = held.subarray(end)
    await this.emit(held.subarray(0, end))
  }

  /**
   * Settle the last line once kubectl has exited.
   *
   * @param exitCode kubectl's exit status.
   * @returns true when the status is the program's; false when kubectl
   *   failed by itself and the program's is unknown.
   */
  async finish(exitCode: number): Promise<boolean> {
    const held = this.held
    this.held = Buffer.alloc(0)
    if (
      exitCode !== 0 &&
      held.equals(Buffer.concat([EXIT_PREFIX, Buffer.from(`${String(exitCode)}\n`)]))
    ) {
      return true
    }
    await this.emit(held)
    return exitCode === 0
  }
}

/**
 * A running pod, reached through `kubectl exec`.
 *
 * You create the pod yourself; mirage only connects to it and execs
 * lines. The `kubectl` program is the transport, with the credentials
 * and context it already has, so there is no SDK dependency; each line
 * is one `kubectl exec`, `--stdin` when it has input, with separated stderr.
 * `kubectl exec` has no `-w`/`-e`, so the working directory and
 * environment ride the command, as over SSH.
 *
 * A pod is a machine whatever isolates it: on EKS, a pod with
 * `runtimeClassName: isolated-sandbox` is a Nitro Sandbox. A
 * `confidential-sandbox` pod denies exec, so it cannot take a line.
 */
export class KubernetesMachine extends ProgramMachine<KubernetesConfig> {
  static override readonly configFields: ConfigFields = KUBERNETES_CONFIG_FIELDS
  static override readonly provider = 'kubernetes'
  protected readonly program = 'kubectl'
  protected readonly installHint = KUBECTL_HINT

  constructor(name: string, config?: KubernetesConfig) {
    super(name, config, KubernetesMachine.configFields)
    requireId('kubernetes', 'pod', this.config.pod)
  }

  /** The pod it runs in. */
  override get instance(): string {
    return this.config.pod
  }

  /** The flags naming the pod's cluster and namespace. */
  private scope(): string[] {
    const { context, namespace } = this.config
    return [
      ...(context === undefined ? [] : ['--context', context]),
      ...(namespace === undefined ? [] : ['--namespace', namespace]),
    ]
  }

  protected execWords(stdin = true): readonly [readonly string[], readonly string[]] {
    const { container, pod } = this.config
    return [
      [
        'exec',
        ...(stdin ? ['--stdin'] : []),
        '--quiet',
        ...this.scope(),
        ...(container === undefined ? [] : ['--container', container]),
      ],
      [pod, '--'],
    ]
  }

  async connect(): Promise<void> {
    const { pod } = this.config
    const status = await this.execProgram(['get', 'pod', ...this.scope(), pod, '--output', 'json'])
    const phase = reportedState(status, 'kubectl get pod', ['status', 'phase'])
    if (phase !== RUNNING_PHASE) throw new Error(notRunningHint('pod', pod, phase, {}))
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn | null,
    errors: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    // A run with no input takes no stdin, so its program's end of input
    // does not ride kubectl's stream.
    const given = stdin !== null && !(stdin instanceof Uint8Array && stdin.byteLength === 0)
    const [head, tail] = this.execWords(given)
    const line = wrapLine(argv, env, cwd)
    const said = new ExitLineFilter(errors)
    let done: RunResult
    try {
      done = await this.execProgram(
        [...head, ...tail, '/bin/sh', '-c', given ? line : emptyStdin(line)],
        given ? stdin : null,
        output,
        signal,
        (data) => said.write(data),
      )
    } catch (error) {
      // A failed kubectl reports nothing, so what is held is the program's.
      // A cancel skips this: a receiver that stopped reading would hold up
      // the stop.
      if (signal?.aborted !== true) await said.finish(0)
      throw error
    }
    if (!(await said.finish(done.exitCode))) {
      throw new ConnectionLostError(
        `kubectl exited ${String(done.exitCode)} without the program's status`,
        done.stdout,
        said.kept,
      )
    }
    return { stdout: done.stdout, stderr: said.kept, exitCode: done.exitCode }
  }

  override openPipe(command: string): Promise<MachinePipe> {
    const [head, tail] = this.execWords()
    return openProgramPipe(this.program, [...head, ...tail, '/bin/sh', '-c', ownStdin(command)])
  }
}

registerMachine('kubernetes', KubernetesMachine)
