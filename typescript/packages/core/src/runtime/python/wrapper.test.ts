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

import { describe, expect, it } from 'vitest'
import { PyodideRuntime } from './pyodide.ts'
import { PYTHON_EVAL_WRAPPER, PYTHON_REPL_WRAPPER, PYTHON_WRAPPER } from './wrapper.ts'

// These constants are Python programs living inside TypeScript template
// literals, a combination with one sharp edge: a plain template literal
// processes backslash escapes before Python ever sees the text, so a
// lone `\n` written inside an embedded Python string literal becomes a
// REAL newline and truncates that literal. The symptom is remote from
// the cause -- every pyodide run dies with `pyodide_fatal_error`,
// including `print(42)` -- which is why this compiles each wrapper with
// the real CPython that is going to run it and names the one that broke.
//
// The literals are `String.raw` so the escapes mean what they say; that
// is the fix, and this is the backstop. Reading the .ts file and
// un-escaping it by hand is NOT a substitute: doing that models the
// escaping wrong and reports a false pass.
const WRAPPERS: readonly (readonly [string, string])[] = [
  ['PYTHON_WRAPPER', PYTHON_WRAPPER],
  ['PYTHON_EVAL_WRAPPER', PYTHON_EVAL_WRAPPER],
  ['PYTHON_REPL_WRAPPER', PYTHON_REPL_WRAPPER],
]

describe('embedded python wrappers', { timeout: 120_000 }, () => {
  it('every wrapper compiles on the interpreter that runs it', async () => {
    const rt = new PyodideRuntime()
    try {
      for (const [name, src] of WRAPPERS) {
        const result = await rt.eval("compile(_src, _name, 'exec') and 'ok'", {
          inputs: { _src: src, _name: name },
        })
        expect(result.value, `${name} is not valid python`).toBe('ok')
      }
    } finally {
      await rt.close()
    }
  })
})
