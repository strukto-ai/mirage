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

import { Runtime } from './base.ts'
import { UnsupportedExecutionError } from './errors.ts'
import type {
  ExecutionRequest,
  RunArgs,
  RunResult,
  RuntimeLanguage,
  RuntimeCapabilities,
  RuntimeContext,
} from './types.ts'

/**
 * A runtime that interprets one language's code inside a command.
 *
 * The engine inside a single command (python3, node): the workspace
 * splits the line, and a captured stage's code lands here as run().
 * Never the whole line; that is LineExecutor's door.
 *
 * The language it interprets is declared once, for both doors: run()
 * for a script CLI (runtimeForLanguage) and eval() for a config-borne
 * policy script (evaluatorOf). One attribute, because two would let a
 * runtime claim python at one door and js at the other, and the
 * disagreement would only surface as an unexplained 127 or a policy
 * evaluated on the wrong engine. Concrete runtimes inherit it from
 * their language tier (PythonRuntime, JsRuntime) rather than declaring
 * it per class.
 *
 * A host adapter receives data, namespace and gated session views through
 * WorkspaceBinding and its per-execution RuntimeContext. Guests receive
 * only RunArgs.env,
 * a copy whose writes do not mutate the Mirage session; the adapter must
 * explicitly use the gated SessionView for any intended session write.
 */
export abstract class LanguageRuntime extends Runtime {
  abstract readonly language: RuntimeLanguage

  override get capabilities(): RuntimeCapabilities {
    return { ...super.capabilities, languages: [this.language] }
  }

  protected override async executeRequest(
    request: ExecutionRequest,
    context?: RuntimeContext,
  ): Promise<RunResult> {
    if (request.kind === 'code') {
      if (request.language !== this.language)
        throw new UnsupportedExecutionError(
          `${this.name}: ${request.language} execution is unsupported`,
        )
      return this.executeCode(request, context)
    }
    return super.executeRequest(request, context)
  }

  protected executeCode(args: RunArgs, _context?: RuntimeContext): Promise<RunResult> {
    return this.run(args)
  }

  /** Report the bound interpreter's version. */
  version(
    _env: Record<string, string>,
    _signal?: AbortSignal,
    _timeoutSeconds?: number,
  ): Promise<RunResult> {
    return Promise.resolve({
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode(`${this.name}: version information unavailable\n`),
      exitCode: 1,
    })
  }

  /** Execute one program and return its captured outcome. */
  abstract run(args: RunArgs): Promise<RunResult>
}
