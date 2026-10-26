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

import type { Context } from '../../../commands/config.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import {
  HOME_CONFIG_KEYS,
  resolveHome,
  type HomeConfig,
  type RuntimeOptions,
} from '../../config.ts'
import { RuntimeFiles } from '../../files.ts'
import type { OutputFn, Program, RunResult } from '../../types.ts'
import { mergeSignals } from '../../../utils/abort.ts'
import { WasmExecution, workerUnavailable } from '../../wasm/execution.ts'
import { loadWasm } from '../../wasm/loader.ts'
import { WasmView } from '../../wasm/view.ts'
import { JsRuntime } from '../base.ts'
import { QuickJsUnavailableError } from './errors.ts'
import { cwdPreamble } from './execution.ts'

export const QUICKJS_HOME_ENV = 'MIRAGE_QUICKJS_HOME'

const WASM_NAME = 'qjs-wasi.wasm'

const BUILD_HINT =
  `the quickjs runtime needs a ${WASM_NAME} module: download a WASI build of quickjs-ng ` +
  'from https://github.com/quickjs-ng/quickjs/releases, and point the runtime entry’s ' +
  'config `home` (yaml `runtimes: [{name: quickjs, config: {home: ...}}]`) or the ' +
  `${QUICKJS_HOME_ENV} environment variable at the directory (a URL on a page) holding it`

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/**
 * Run JavaScript on a WASI quickjs-ng, the engine the Python host runs.
 *
 * A bare modern JS engine (ES2023 syntax, ES modules, `JSON`, regex,
 * `Promise`, top-level await) inside a wasm sandbox: no node builtins,
 * no `require`, no npm, no network. The `std`/`os` globals are exposed
 * (quickjs-ng `--std`), so scripts read stdin with
 * `std.in.readAsString()` and reach files with `std.open`/`os.readdir`.
 * The engine's filesystem imports are intercepted, so file I/O routes
 * through the workspace dispatch, with the same cache, write modes and
 * session narrowing as shell commands.
 *
 * Each run is on a worker of its own (`WasmExecution`), so a stopped run
 * ends its worker, however busy the guest. The module comes from the
 * config `home` or the MIRAGE_QUICKJS_HOME environment variable, a
 * directory on Node and a URL on a page. Mirrors Python's `QuickJsRuntime`.
 */
export class QuickJsRuntime extends JsRuntime<WasmExecution> {
  readonly name = 'quickjs'
  // The engine is a WASI guest whose `std.open`/`os.readdir` wait on the
  // workspace bridge: guest I/O has no way around the gate.
  override readonly reach = 'workspace'
  override readonly filesystem = ['read', 'write', 'list', 'stat'] as const

  constructor(options: RuntimeOptions = {}) {
    super(options, HOME_CONFIG_KEYS)
  }

  protected override async openEngine(): Promise<WasmExecution> {
    const home = resolveHome(this.config as HomeConfig, QUICKJS_HOME_ENV)
    if (home === undefined) throw new QuickJsUnavailableError(BUILD_HINT)
    const unavailable = await workerUnavailable()
    if (unavailable !== null) throw new QuickJsUnavailableError(unavailable)
    return new WasmExecution(async () => {
      try {
        return await loadWasm(home, WASM_NAME)
      } catch (err) {
        throw new QuickJsUnavailableError(`no ${WASM_NAME} under ${home}; ${BUILD_HINT}`, {
          cause: err,
        })
      }
    }, 'js')
  }

  protected override closeEngine(engine: WasmExecution): Promise<void> {
    return engine.close()
  }

  override async version(env: Record<string, string>, signal?: AbortSignal): Promise<RunResult> {
    const engine = await this.engine()
    const [stdout, stderr, exitCode] = await engine.run(
      ['qjs', '--version'],
      null,
      Object.entries(env),
      new WasmView(),
      undefined,
      undefined,
      signal,
    )
    return {
      stdout:
        exitCode === 0
          ? ENC.encode(`JavaScript (quickjs-ng ${DEC.decode(stdout).trim()})\n`)
          : stdout,
      stderr,
      exitCode,
    }
  }

  /**
   * Run one program on the install's engine.
   *
   * @param engine - the install's compiled module and its workers.
   * @param program - the source and argv to run.
   * @param ctx - the run's context.
   * @param output - receives stdout as it is written; absent returns it.
   * @param errors - the same for stderr.
   */
  async interpret(
    engine: WasmExecution,
    program: Program,
    ctx: Context,
    output?: OutputFn,
    errors?: OutputFn,
  ): Promise<RunResult> {
    const module = ctx.flags.module === true
    // --std exposes the std/os globals (stdin via std.in); -m selects
    // ES-module mode for .mjs sources, and --script names classic mode for
    // the rest, since qjs takes -e source for a module unless told (a
    // sloppy `x = 5` then fails strict). Trailing args become scriptArgs.
    // A named program takes scriptArgs[0], the slot qjs fills with a
    // script's path when it runs a file; unnamed -e leaves the args alone.
    // `--` is load-bearing: qjs's -e does not end its option parsing, so a
    // program argument that spells a qjs switch would be read as one.
    const named = program.prog !== undefined && program.prog !== '' ? [program.prog] : []
    const cwd = ctx.cwd
    let source = program.code
    if (cwd.virtual !== '/') {
      // Evaluate scripts separately so their directive prologue still
      // controls strict mode. Modules are already strict.
      if (module && source.startsWith('#!')) source = `//${source.slice(2)}`
      if (!module) source = `std.evalScript(${JSON.stringify(source)});`
      source = cwdPreamble(cwd) + source
    }
    const argv = [
      'qjs',
      '--std',
      module ? '-m' : '--script',
      '-e',
      source,
      '--',
      ...named,
      ...program.args,
    ]
    const deadline =
      ctx.timeoutSeconds !== undefined && ctx.timeoutSeconds > 0
        ? AbortSignal.timeout(Math.min(Math.ceil(ctx.timeoutSeconds * 1000), 2 ** 31 - 1))
        : undefined
    try {
      const [stdout, stderr, exitCode] = await engine.run(
        argv,
        program.stdin,
        Object.entries(ctx.env ?? {}),
        new WasmView(RuntimeFiles.of(ctx, this.binding)),
        output,
        errors,
        mergeSignals(ctx.signal, deadline),
      )
      return { stdout, stderr, exitCode }
    } catch (err) {
      if (ctx.signal?.aborted === true) {
        // A cancelled run's stop is no error of the program's: it ends as a
        // killed one does, saying nothing, as Monty's does.
        return { stdout: new Uint8Array(), stderr: null, exitCode: 1 }
      }
      if (deadline?.aborted === true && ctx.timeoutSeconds !== undefined)
        throw new CommandTimeoutError(this.name, ctx.timeoutSeconds)
      throw err
    }
  }
}
