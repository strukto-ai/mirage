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
import { renderHelp } from '../../spec/help.ts'
import {
  ROOT_SPEC,
  gwsHelpCommands,
  renderServiceMethods,
  renderServices,
  serviceNames,
} from './help.ts'
import { GWS_METHODS } from './methods.ts'

describe('gws help', () => {
  it('lists the services in display order', () => {
    expect(serviceNames()).toEqual(['drive', 'sheets', 'docs', 'slides', 'gmail'])
  })

  it('counts every method in the service index', () => {
    const out = renderServices()
    expect(out.split('\n')[0]).toBe('Services:')
    for (const name of serviceNames()) {
      const count = GWS_METHODS.filter((m) => m.service === name).length
      expect(out).toContain(name)
      expect(out).toContain(`${String(count)} API methods`)
    }
    expect(out.endsWith("Run 'gws <service> --help' to list a service's commands.")).toBe(true)
  })

  it('lists a service methods and helpers', () => {
    const out = renderServiceMethods('sheets')
    expect(out.split('\n')[0]).toBe('Methods:')
    expect(out).toContain('gws sheets spreadsheets get')
    expect(out).toContain('GET /spreadsheets/{spreadsheetId}')
    expect(out).toContain('Helpers:')
    expect(out).toContain('gws sheets +read')
    expect(out.endsWith("Run '<command> --help' for one command's flags.")).toBe(true)
  })

  it('omits the helper block for a service without helpers', () => {
    expect(renderServiceMethods('slides')).not.toContain('Helpers:')
  })

  it('renders the service index as the root help epilog', () => {
    const out = renderHelp('gws', ROOT_SPEC)
    expect(out.startsWith('gws: Google Workspace API commands')).toBe(true)
    expect(out).toContain(renderServices())
  })

  it('registers every reachable service for a drive mount', () => {
    const cmds = gwsHelpCommands('gdrive')
    expect(new Set(cmds.map((c) => c.name))).toEqual(
      new Set(['gws', 'gws drive', 'gws sheets', 'gws docs', 'gws slides']),
    )
    expect(new Set(cmds.map((c) => c.resource))).toEqual(new Set(['gdrive']))
  })

  it('registers only the reachable services for a single-service mount', () => {
    // A gdocs-only mount must not answer `gws gmail` or `gws drive`.
    expect(new Set(gwsHelpCommands('gdocs').map((c) => c.name))).toEqual(
      new Set(['gws', 'gws docs']),
    )
    expect(new Set(gwsHelpCommands('gmail').map((c) => c.name))).toEqual(
      new Set(['gws', 'gws gmail']),
    )
  })
})
