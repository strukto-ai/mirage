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

import type { GhConfig } from './config.ts'
import { parseRepo } from './repo.ts'

const PLACEHOLDER_RE = /\{(owner|repo|branch)\}/g
const EXPAND_ERROR = 'unable to expand placeholder in path'

function value(name: string, config: GhConfig): string {
  if (name === 'branch') {
    if (config.branch === undefined || config.branch === '') {
      throw new Error(`${EXPAND_ERROR}: no \`branch\` on the install`)
    }
    return config.branch
  }
  if (config.repo === undefined || config.repo === '') {
    throw new Error(`${EXPAND_ERROR}: no \`repo\` on the install`)
  }
  const ref = parseRepo(config.repo)
  return name === 'owner' ? ref.owner : ref.repo
}

/**
 * Expand gh's repository placeholders in an endpoint or field value.
 *
 * Real gh fills `{owner}`, `{repo}` and `{branch}` from the repository of
 * the current directory, which is what most of its own documented examples
 * are written with (`gh api repos/{owner}/{repo}/releases`); an install's
 * `repo`/`branch` are the workspace's stand-in for that. Any other brace
 * pair is left exactly as typed and reaches the wire, which is gh's
 * behavior too: it is a path segment, not a template error.
 */
export function expand(text: string, config: GhConfig): string {
  if (!text.includes('{')) return text
  return text.replace(PLACEHOLDER_RE, (_m, name: string) => value(name, config))
}
