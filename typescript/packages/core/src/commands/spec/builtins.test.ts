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
import { BUILTIN_SPECS } from './builtins.ts'
import { OperandKind } from './types.ts'

describe('BUILTIN_SPECS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(BUILTIN_SPECS)).toBe(true)
  })

  it('contains the core file commands', () => {
    for (const name of ['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'stat', 'cut', 'file']) {
      expect(BUILTIN_SPECS[name], `missing spec: ${name}`).toBeDefined()
    }
  })

  it('ls takes PATH rest args', () => {
    const spec = BUILTIN_SPECS.ls
    expect(spec?.rest?.kind).toBe(OperandKind.PATH)
  })

  it('grep has a TEXT positional arg followed by PATH rest', () => {
    const spec = BUILTIN_SPECS.grep
    expect(spec?.positional[0]?.kind).toBe(OperandKind.TEXT)
    expect(spec?.rest?.kind).toBe(OperandKind.PATH)
  })

  it('head recognizes -n and -c as TEXT-valued flags', () => {
    const spec = BUILTIN_SPECS.head
    const n = spec?.options.find((o) => o.short === '-n')
    const c = spec?.options.find((o) => o.short === '-c')
    expect(n?.valueKind).toBe(OperandKind.TEXT)
    expect(c?.valueKind).toBe(OperandKind.TEXT)
  })

  it('echo has -n and -e boolean flags and TEXT rest', () => {
    const spec = BUILTIN_SPECS.echo
    expect(spec?.rest?.kind).toBe(OperandKind.TEXT)
    const n = spec?.options.find((o) => o.short === '-n')
    const e = spec?.options.find((o) => o.short === '-e')
    expect(n?.valueKind).toBe(OperandKind.NONE)
    expect(e?.valueKind).toBe(OperandKind.NONE)
  })

  it('du has a long --max-depth flag with TEXT value', () => {
    const spec = BUILTIN_SPECS.du
    const maxDepth = spec?.options.find((o) => o.long === '--max-depth')
    expect(maxDepth?.valueKind).toBe(OperandKind.TEXT)
  })

  it('covers the full python set size', () => {
    expect(Object.keys(BUILTIN_SPECS).length).toBe(80)
  })
})
