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

import { IOResult } from '../../io/types.ts'
import { cliSpecFor, registerCliSpec, unregisterCliSpec } from './specs.ts'
import { CLISpec } from './types.ts'

// Mirrors python/tests/commands/cli/test_specs.py.

function noop(): [null, IOResult] {
  return [null, new IOResult()]
}

function tree(name: string): CLISpec {
  return new CLISpec({ name, subcommands: [new CLISpec({ name: 'run', fn: noop })] })
}

describe('cli spec registry', () => {
  it('registers, resolves, and unregisters', () => {
    const spec = tree('spectest')
    registerCliSpec(spec)
    try {
      expect(cliSpecFor('spectest')).toBe(spec)
    } finally {
      unregisterCliSpec('spectest')
    }
    expect(() => cliSpecFor('spectest')).toThrow(/unknown cli 'spectest'/)
  })

  it('refuses duplicate registration', () => {
    registerCliSpec(tree('spectest2'))
    try {
      expect(() => {
        registerCliSpec(tree('spectest2'))
      }).toThrow(/already registered/)
    } finally {
      unregisterCliSpec('spectest2')
    }
  })

  it('unregistering an unknown name throws', () => {
    expect(() => {
      unregisterCliSpec('spectest3')
    }).toThrow(/not registered/)
  })

  it('an unknown key names the known specs', () => {
    expect(() => cliSpecFor('spectest4')).toThrow(/known: /)
  })
})
