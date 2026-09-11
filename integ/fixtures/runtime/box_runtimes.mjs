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

// The TypeScript twin of box_runtimes.py: the same two runtimes, one per
// tier, loaded from yaml through `runtimes: [{name: ./box_runtimes.mjs:EchoBox}]`.
import { LanguageRuntime, LINE_EXECUTOR, Runtime } from '@struktoai/mirage-node'

const ENC = new TextEncoder()

export class EchoBox extends Runtime {
  [LINE_EXECUTOR] = true
  name = 'echobox'

  constructor(options = {}) {
    super(options, ['nvidia-smi'], [])
  }

  runLine(line) {
    return Promise.resolve({ stdout: ENC.encode(`box:${line}\n`), stderr: null, exitCode: 0 })
  }
}

export class ShoutPython extends LanguageRuntime {
  name = 'shout'
  language = 'python'

  constructor(options = {}) {
    super(options, ['python3', 'python'], [])
  }

  run(args) {
    return Promise.resolve({
      stdout: ENC.encode(`${args.code.toUpperCase()}\n`),
      stderr: null,
      exitCode: 0,
    })
  }
}

// Loadable, but not a runtime: the reference form must refuse it by name.
export const NOT_A_RUNTIME = { name: 'nope' }
