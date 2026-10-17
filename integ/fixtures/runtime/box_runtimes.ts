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

// The typed twin of box_runtimes.mjs, loaded through Node's own type
// stripping (`runtimes: [{name: ./box_runtimes.ts:EchoBox}]`), so it uses
// only erasable syntax: no enums, no parameter properties.
import {
  type Context,
  LanguageRuntime,
  LINE_EXECUTOR,
  type LineExecutor,
  type PathSpec,
  type Program,
  type RunResult,
  Runtime,
} from '@struktoai/mirage-node'

const ENC = new TextEncoder()

export class EchoBox extends Runtime<undefined> implements LineExecutor<undefined> {
  readonly [LINE_EXECUTOR] = true as const
  readonly name = 'echobox'

  constructor(options = {}) {
    super(options, ['nvidia-smi'], [])
  }

  runLine(
    _engine: undefined,
    _paths: PathSpec[],
    _texts: string[],
    ctx: Context,
  ): Promise<RunResult> {
    const line = ctx.flags.c as string
    return Promise.resolve({ stdout: ENC.encode(`box:${line}\n`), stderr: null, exitCode: 0 })
  }
}

export class ShoutPython extends LanguageRuntime<undefined> {
  readonly name = 'shout'
  readonly language = 'python' as const

  constructor(options = {}) {
    super(options, ['python3', 'python'], [])
  }

  interpret(_engine: undefined, program: Program, _ctx: Context): Promise<RunResult> {
    return Promise.resolve({
      stdout: ENC.encode(`${program.code.toUpperCase()}\n`),
      stderr: null,
      exitCode: 0,
    })
  }
}

// Loadable, but not a runtime: the reference form must refuse it by name.
export const NOT_A_RUNTIME = { name: 'nope' }
