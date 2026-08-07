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
import type { RuntimeLanguage } from '../types.ts'

/**
 * The python tier: every runtime that interprets Python source.
 *
 * Groups the engines behind the python3/python commands (pyodide,
 * monty here; wasi, local in Python and @struktoai/mirage-node), so
 * `language` is declared once and python-tier behavior has one home.
 * A new Python engine subclasses this, not LanguageRuntime.
 */
export abstract class PythonRuntime extends LanguageRuntime {
  readonly language: RuntimeLanguage = 'python'
}
