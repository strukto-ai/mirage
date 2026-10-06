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
import { stripDeniedImports } from './runtime.ts'

describe('stripDeniedImports', () => {
  // The match is anchored at a line's start after optional whitespace,
  // as Pyodide's own import scanner walks indented imports, so an import
  // inside a function body is rewritten while a comment or a string that
  // merely reads like one is not, and only a whole top-level name counts.
  it.each<[string, string, string[], string]>([
    [
      'nothing denied',
      'import numpy\nimport pandas as pd\n',
      [],
      'import numpy\nimport pandas as pd\n',
    ],
    ['a bare import', 'import numpy\n', ['numpy'], 'import os\n'],
    [
      'an aliased import, keeping the alias',
      'import numpy as np\n',
      ['numpy'],
      'import os as np\n',
    ],
    ['a submodule, by its top-level name', 'import numpy.linalg\n', ['numpy'], 'import os\n'],
    [
      'from X and from X.Y',
      'from numpy import array\nfrom numpy.linalg import norm\n',
      ['numpy'],
      'from os import array\nfrom os import norm\n',
    ],
    [
      'imports not denied',
      'import os\nimport sys\nfrom collections import deque\n',
      ['numpy'],
      'import os\nimport sys\nfrom collections import deque\n',
    ],
    [
      'several denied packages',
      'import numpy\nimport pandas\nimport requests\n',
      ['numpy', 'pandas'],
      'import os\nimport os\nimport requests\n',
    ],
    [
      'an indented import',
      'def f():\n    import numpy\n    return 1\n',
      ['numpy'],
      'def f():\n    import os\n    return 1\n',
    ],
    [
      'a name that merely contains a denied one',
      'import numpyish\nfrom numpy_utils import x\n',
      ['numpy'],
      'import numpyish\nfrom numpy_utils import x\n',
    ],
    [
      'a comment or string that reads like an import',
      '# import numpy\nx = "import numpy"\nprint(x)\n',
      ['numpy'],
      '# import numpy\nx = "import numpy"\nprint(x)\n',
    ],
  ])('rewrites %s', (_name, code, denied, expected) => {
    expect(stripDeniedImports(code, new Set(denied))).toBe(expected)
  })
})
