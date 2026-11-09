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

import { BOOLEAN } from './constants.ts'
import { Argument } from '../../../spec/types.ts'

export const REPO = new Argument(['-R', '--repo'], {
  help: 'Select another repository using the [HOST/]OWNER/REPO format',
})
export const JSON = new Argument('--json', {
  metavar: 'fields',
  help: 'Output JSON with the specified fields',
})
export const JQ = new Argument(['-q', '--jq'], {
  metavar: 'expression',
  help: 'Filter JSON output using a jq expression',
})
export const TEMPLATE = new Argument(['-t', '--template'], {
  help: 'Format JSON output using a Go template; see "gh help formatting"',
})

// gh's boolean flags are pflag's: a bare `--draft` is true, and `--draft=true`
// or `--draft=false` spells the value out, which is how a script turns one
// off. Their shorts still cluster (`-sd`). Read one with `gh_bool`.
export function flag(init: {
  short?: string
  long: string
  description?: string
  metavar?: string
}): Argument {
  return new Argument([...(init.short === undefined ? [] : [init.short]), init.long], {
    nargs: '?',
    attachedOnly: true,
    metavar: init.metavar ?? null,
    help: init.description ?? null,
    shortValue: false,
    choices: BOOLEAN,
  })
}
