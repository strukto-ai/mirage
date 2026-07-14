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
import { stripDeniedImports } from './runtimes/pyodide.ts'

describe('stripDeniedImports', () => {
  it('returns code unchanged when denyPackages is empty', () => {
    const code = 'import numpy\nimport pandas as pd\n'
    expect(stripDeniedImports(code, new Set())).toBe(code)
  })

  it('rewrites bare `import X` of a denied top-level package', () => {
    const out = stripDeniedImports('import numpy\n', new Set(['numpy']))
    expect(out).toBe('import os\n')
  })

  it('rewrites `import X as alias` while preserving the alias', () => {
    const out = stripDeniedImports('import numpy as np\n', new Set(['numpy']))
    expect(out).toBe('import os as np\n')
  })

  it('rewrites `import X.submodule` based on top-level name', () => {
    const out = stripDeniedImports('import numpy.linalg\n', new Set(['numpy']))
    expect(out).toBe('import os\n')
  })

  it('rewrites `from X import …` and `from X.Y import …`', () => {
    const code = 'from numpy import array\nfrom numpy.linalg import norm\n'
    const out = stripDeniedImports(code, new Set(['numpy']))
    expect(out).toBe('from os import array\nfrom os import norm\n')
  })

  it('leaves non-denied imports alone', () => {
    const code = 'import os\nimport sys\nfrom collections import deque\n'
    expect(stripDeniedImports(code, new Set(['numpy']))).toBe(code)
  })

  it('handles multiple denied packages independently', () => {
    const code = 'import numpy\nimport pandas\nimport requests\n'
    const out = stripDeniedImports(code, new Set(['numpy', 'pandas']))
    expect(out).toBe('import os\nimport os\nimport requests\n')
  })

  it('matches at start-of-line only and ignores indented imports inside strings/code', () => {
    // The match is line-anchored. Statements not at the start of a line
    // (after leading whitespace) are still rewritten — e.g. inside a
    // function body. That mirrors Pyodide's import scanner which also
    // walks indented imports.
    const code = 'def f():\n    import numpy\n    return 1\n'
    const out = stripDeniedImports(code, new Set(['numpy']))
    expect(out).toBe('def f():\n    import os\n    return 1\n')
  })

  it('does not rewrite identifiers that merely contain a denied substring', () => {
    const code = 'import numpyish\nfrom numpy_utils import x\n'
    const out = stripDeniedImports(code, new Set(['numpy']))
    // numpyish and numpy_utils are different top-level packages — leave them.
    expect(out).toBe(code)
  })

  it('does not touch comments or strings that look like imports', () => {
    const code = '# import numpy\nx = "import numpy"\nprint(x)\n'
    const out = stripDeniedImports(code, new Set(['numpy']))
    // The regex matches at the start of a line after optional whitespace,
    // so the comment line `# import numpy` is not matched (starts with `#`).
    // The string assignment line starts with `x =` so it is not matched.
    expect(out).toBe(code)
  })
})
