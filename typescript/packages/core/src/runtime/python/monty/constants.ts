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

export const MISSING_PACKAGE_HINT =
  "monty runtime requires the '@pydantic/monty' package — install it or select the pyodide runtime"

// argv[0] when the caller named no program of its own.
export const DEFAULT_PROG = 'main.py'

// One-shot eval is bounded like quickjs's: nothing above the runtime
// can stop a hung guest, so the runtime owns its own interrupt.
export const EVAL_INTERRUPT_SECONDS = 10

// A console tells "keep typing" from "this is broken" by matching
// monty's own traceback wording, so a version that rephrases either
// line turns every continuation into an error at the prompt.
export const INCOMPLETE_MARKERS = ['unexpected EOF', 'Expected an indented block'] as const
