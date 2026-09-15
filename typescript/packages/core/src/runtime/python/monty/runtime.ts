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

import { PythonRuntime } from '../base.ts'
import { EVALUATOR, type Evaluator } from '../../mixin.ts'
import type {
  EvalResult,
  EvalValue,
  RunArgs,
  RunResult,
  RuntimeOptions,
  RuntimeContext,
} from '../../types.ts'
import { RuntimeVFS } from '../../vfs.ts'
import { unhonoredNotice, type InitFlags } from '../flags.ts'
import { MontyVFS } from './vfs.ts'
import { MontyExecution } from './execution.ts'

/**
 * Run Python code on the Monty sandboxed interpreter (`@pydantic/monty`).
 *
 * Code executes in a crash-isolated Monty worker: no host filesystem,
 * environment, or network access. `pathlib` I/O is serviced through the
 * workspace bridge, so the code sees the workspace mounts and nothing
 * else, and the run's env is readable both ways python's monty spells
 * it: `os.getenv` and `os.environ` (a dict copy, so the two hosts run
 * the same program). Command-line arguments are exposed as the
 * `argv` global (`argv[0]` is the script name) and piped input as the
 * `stdin` global (bytes, None when nothing was piped). The builtin
 * `open()` is bridged (@pydantic/monty 0.0.21 carries a
 * `MontyFileHandle` back from the `os` callback), and a path under no
 * mount lives in a per-run in-memory scratch tree, exactly like
 * python's binding-side tree — so `/tmp` is real scratch space on both
 * hosts. Monty implements a Python subset; host-only features
 * (`sys.stdin`, `sys.argv`, third-party imports) are unavailable, and
 * `Path.stat()` stays unbridged until the JS binding grows a
 * StatResult marker (see MirageOSAccess) — use the pyodide runtime
 * when a guest needs stat.
 */
export class MontyRuntime extends PythonRuntime implements Evaluator {
  readonly name = 'monty'
  protected override readonly versionSuffix = ' (monty)'
  // The interpreter is an in-process guest with no host syscalls: its
  // file I/O can only travel the VFS bridge, so every effect passes
  // the workspace gate (mount modes, policy, recording).
  override readonly reach = 'vfs'
  override readonly filesystem = ['read', 'write', 'list'] as const
  // No import system to resolve a module with, so `-m` has nothing to
  // run; the refusal names this runtime rather than inventing a
  // "No module named" that would imply a search happened.
  override readonly runsModules = false
  readonly [EVALUATOR] = true as const
  private readonly execution = new MontyExecution()

  constructor(options: RuntimeOptions = {}) {
    super(options)
  }

  /**
   * Run one program, reporting any switch this engine cannot honor.
   *
   * Monty implements a Python subset with no `compile`, no `warnings`
   * and no `sys.path`, so the interpreter-init switches have nothing to
   * act on here even though every real-CPython engine honors them. The
   * notice rides on stderr and the program's own exit code stands.
   *
   * Args:
   *   args: the execution request.
   */
  protected override executeCode(args: RunArgs, context?: RuntimeContext): Promise<RunResult> {
    return this.run(args, context)
  }

  async run(args: RunArgs, context = this.captureContext()): Promise<RunResult> {
    const notice = unhonoredNotice((args.flags ?? {}) as InitFlags, this.name)
    const result = await this.execution.run(args, this.perRunVfs(context))
    if (notice.length === 0) return result
    const stderr = result.stderr ?? new Uint8Array()
    const merged = new Uint8Array(notice.length + stderr.length)
    merged.set(notice, 0)
    merged.set(stderr, notice.length)
    return { ...result, stderr: merged }
  }

  eval(
    code: string,
    opts: { inputs?: Record<string, EvalValue>; session?: string } = {},
  ): Promise<EvalResult> {
    return this.execution.eval(code, this.perRunVfs(this.captureContext()), opts)
  }

  override close(): Promise<void> {
    return this.execution.close()
  }

  private perRunVfs(context?: RuntimeContext): MontyVFS | null {
    return context === undefined
      ? null
      : new MontyVFS(new RuntimeVFS(context.dispatch, context.resolver))
  }
}
