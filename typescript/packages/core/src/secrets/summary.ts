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

import type { z } from 'zod'

import { compareCodePoints } from '../utils/sort.ts'

// Past this many, what came back is not a secret's shape, and reciting
// a host's names back to the agent is neither a useful hint nor ours to
// print.
export const MAX_LISTED_FIELDS = 12

// Sources whose fields are the host's shape rather than a secret's,
// and are never named back however few of them there are: a hardened
// container starts from `env -i` plus a handful of credentials, so a
// count threshold alone would recite exactly the environment worth
// hiding.
export const OPAQUE_FIELD_SOURCES: ReadonlySet<string> = new Set(['env'])

/**
 * How a refusal names the fields the secret did carry.
 *
 * Its own module because both planes word this refusal -- the config
 * plane's `resolveSources` and the env plane's `fillEnv`, from
 * different packages -- and `errors.ts` is for the package's exception
 * types. Returns what follows "has" in the message: the labels for a
 * secret of ordinary size, a bare count for the process environment or
 * for anything big enough to be one.
 */
export function fieldSummary(fields: Readonly<Record<string, string>>, source: string): string {
  const names = Object.keys(fields)
  if (OPAQUE_FIELD_SOURCES.has(source) || names.length > MAX_LISTED_FIELDS) {
    return `${String(names.length)} fields`
  }
  return `{${names.sort(compareCodePoints).join(', ')}}`
}

/**
 * How a refusal names what a config schema rejected.
 *
 * The field path and the issue code per issue, and nothing else -- not
 * zod's rendered message, which a custom refinement is free to build
 * out of the input it refused. Every config this plane parses is one a
 * fetched credential may have just landed in: a source's own, a mount's,
 * an account CLI's. An unrecognized key carries no path, so its own
 * names stand in; they are what the deployment wrote in the block, not
 * anything fetched. Mirrors Python's `error_summary`, which has the
 * harder job: pydantic's rendering quotes the input outright.
 */
export function errorSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.')
      // A model-level refinement (one credential of two, one drive target of
      // four) carries no path; python's `error_summary` reports it as `config`.
      const where =
        path !== '' ? path : issue.code === 'unrecognized_keys' ? issue.keys.join(', ') : 'config'
      return `${where}: ${issue.code}`
    })
    .join('; ')
}

/**
 * `message` with each value fetched into a config replaced by `***`.
 *
 * For a refusal raised over a config a secret was read into, whose check
 * quotes the value it refused (`not "ssh2"`): the create route answers
 * that message as its detail, and would hand the secret back. A value is
 * masked as it is and as JSON escapes it, the longest form first, so a
 * value holding another is masked whole. Mirrors Python's `mask_values`,
 * which also masks the form `repr` quotes.
 */
export function maskValues(message: string, values: Iterable<string>): string {
  const forms = new Set<string>()
  for (const value of values) {
    if (value === '') continue
    forms.add(value)
    forms.add(JSON.stringify(value).slice(1, -1))
  }
  let out = message
  for (const form of [...forms].sort((a, b) => b.length - a.length))
    out = out.split(form).join('***')
  return out
}
