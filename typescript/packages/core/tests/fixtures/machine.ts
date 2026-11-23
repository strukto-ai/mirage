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

import { MachineTable } from '../../src/execution/machine/table.ts'
import { materialize, type ByteSource } from '../../src/io/types.ts'
import { RUN_PROGRAM_AT, RUN_WRAPPER_JOINED, isRun } from '../../src/machine/constants.ts'
import { MachineHandle } from '../../src/machine/handle.ts'
import { RemoteRuntime } from '../../src/runtime/machine/runtime.ts'
import type { OutputFn, RunAnswer, RunResult } from '../../src/runtime/types.ts'
import { shellJoin } from '../../src/shell/join.ts'

/** The result for one of a scripted machine's lines and what it was fed. */
export type Answer = (line: string, data: Uint8Array | null) => RunAnswer

/** A line that exited 0 and printed `out`. */
export function ok(out: Uint8Array | string = new Uint8Array()): RunAnswer {
  return {
    stdout: typeof out === 'string' ? new TextEncoder().encode(out) : out,
    stderr: new Uint8Array(),
    exitCode: 0,
  }
}

/** A line that exited `code` and said `err`. */
export function failed(err: string, code = 1): RunAnswer {
  return { stdout: new Uint8Array(), stderr: new TextEncoder().encode(err), exitCode: code }
}

/**
 * A machine whose every line `answer` answers, recording each line and what
 * it was fed. Mirrors Python's `tests/fixtures/machine.ScriptedMachine`.
 */
export class ScriptedMachine extends MachineHandle {
  static override readonly provider = 'scripted'
  readonly lines: string[] = []
  readonly fed: (Uint8Array | null)[] = []
  readonly cwds: string[] = []
  readonly joined: boolean[] = []
  readonly umasks: string[] = []

  constructor(
    name: string,
    private readonly answer: Answer,
    override readonly takesInput = true,
    override readonly joinsStreams = false,
  ) {
    super(name)
  }

  connect(): Promise<void> {
    return Promise.resolve()
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    _env: Record<string, string>,
    cwd: string,
    output: OutputFn,
    errors: OutputFn,
  ): Promise<RunResult> {
    const joined = isRun(argv) && argv[2] === RUN_WRAPPER_JOINED
    if (isRun(argv)) {
      this.cwds.push(cwd)
      this.joined.push(joined)
      this.umasks.push(argv[RUN_PROGRAM_AT - 6] ?? '')
    }
    const run = isRun(argv) ? argv.slice(RUN_PROGRAM_AT) : argv
    const line = run[0] === '/bin/sh' && run[1] === '-c' ? (run[2] ?? '') : shellJoin(run)
    const data = stdin === null ? null : await materialize(stdin)
    this.lines.push(line)
    this.fed.push(data)
    const done = this.answer(line, data)
    if (done.stdout.length > 0) await output(done.stdout)
    if (done.stderr.length > 0) await (this.joinsStreams || joined ? output : errors)(done.stderr)
    return { exitCode: done.exitCode }
  }
}

/** A machine table holding `handles`, in order. */
export function tableOf(...handles: MachineHandle[]): MachineTable {
  return new MachineTable(Object.fromEntries(handles.map((h) => [h.name, h])))
}

// One table per handle, as one workspace holds a handle however many
// runtimes a test binds to it.
const TABLES = new WeakMap<MachineHandle, MachineTable>()

/** A handle whose remote runtime captures `captures`, for a test. */
export function captured<T extends MachineHandle>(handle: T, captures: readonly string[]): T {
  ;(handle as { captures?: readonly string[] }).captures = captures
  return handle
}

/** What a test's fake handle says its runtime captures, undefined for a real one. */
function capturesOf(handle: MachineHandle): readonly string[] | undefined {
  return (handle as { captures?: readonly string[] }).captures
}

/**
 * A remote runtime on one machine, bound to it as a workspace binds its
 * entries, capturing what a fake handle's `captures` names. Mirrors
 * Python's `tests/fixtures/machine.machine_runtime`.
 */
export function machineRuntime(handle: MachineHandle): RemoteRuntime {
  const captures = capturesOf(handle)
  const runtime = new RemoteRuntime(handle.name, captures !== undefined ? { captures } : {})
  let table = TABLES.get(handle)
  if (table === undefined) {
    table = new MachineTable({ [handle.name]: handle })
    TABLES.set(handle, table)
  }
  runtime.bindMachines(table)
  return runtime
}

/**
 * The workspace options that run one machine's programs, capturing what a
 * fake handle's `captures` names. Mirrors Python's
 * `tests/fixtures/machine.on`.
 */
export function on(handle: MachineHandle): { machines: Record<string, MachineHandle> } {
  const captures = capturesOf(handle)
  if (captures !== undefined) {
    const held = handle as { config: MachineHandle['config'] }
    held.config = { ...held.config, captures }
  }
  return { machines: { [handle.name]: handle } }
}
