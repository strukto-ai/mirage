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

import { LanguageRuntime } from '../language.ts'
import type { RuntimeLanguage, RuntimeOptions } from '../types.ts'

/**
 * The python tier: every runtime that interprets Python source.
 *
 * Groups the engines behind the python3/python commands (pyodide,
 * monty here; wasi, local in Python and @struktoai/mirage-node), so
 * `language` and the default captures are declared once and
 * python-tier behavior has one home. A new Python engine subclasses
 * this, not LanguageRuntime.
 *
 * The repl is deliberately not part of this tier: it rides the general
 * Evaluator capability (`isEvaluator` plus `eval` with a session id),
 * which nothing about it makes python-shaped.
 */
export abstract class PythonRuntime extends LanguageRuntime {
  readonly language: RuntimeLanguage = 'python'
  /** The tier's head words: the class-default captures of every python engine. */
  static readonly commands: readonly string[] = ['python3', 'python'] as const

  constructor(options: RuntimeOptions<object> = {}, configKeys: readonly string[] = []) {
    super(options, PythonRuntime.commands, configKeys)
  }
}
