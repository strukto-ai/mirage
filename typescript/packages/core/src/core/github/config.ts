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

import { z } from 'zod'
import type { ConfigOf } from '../../vfs/secrets.ts'
import { secretStr } from '../../vfs/secrets.ts'
import { TimeoutConfig } from '../api/config.ts'

/**
 * A GitHub App installation that mirage mints tokens for. Each token lasts an
 * hour; mirage mints the next one before the last expires, so a long-lived
 * VFS or `gh` install keeps working.
 */
export const GitHubAppAuth = z.preprocess(
  (input: unknown): unknown => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return input
    // The snake_case spellings an `app` block arrives in from yaml or
    // python. The config loader renames only top-level keys, so the nested
    // block does its own, as `AWSSMConfig` does.
    const camels: Readonly<Record<string, string>> = {
      app_id: 'appId',
      private_key: 'privateKey',
      installation_id: 'installationId',
    }
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      const camel = camels[key]
      // Both spellings of one field is refused rather than settled by
      // insertion order: the snake key stays and the strict object
      // reports it, as python reports the camel one.
      if (camel === undefined || Object.hasOwn(input, camel)) out[key] = value
      else out[camel] = value
    }
    return out
  },
  z.strictObject({
    appId: z.union([z.number().int(), z.string()]).describe("The App's ID, or its client ID."),
    privateKey: secretStr().describe(
      "The App's private key, PEM, PKCS#1 as GitHub downloads it or PKCS#8.",
    ),
    installationId: z.number().int().describe('The installation the tokens act for.'),
    repositories: z
      .array(z.string())
      .optional()
      .describe(
        'Repository names the tokens are narrowed to. Unset reaches every repository the installation does.',
      ),
    permissions: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Permissions the tokens are narrowed to, such as `{ contents: "read" }`. Unset grants all the installation has.',
      ),
  }),
)

export type GitHubAppAuth = z.infer<typeof GitHubAppAuth>

/**
 * Refuse a GitHub config that names both credentials, and one that names
 * neither where a credential is `required`: a `gh` install needs a login,
 * while a mount of a public repository reads it with no credential. A
 * credential written as null, as a Python snapshot writes an unset one, is
 * not named.
 */
function checkAuth(
  required: boolean,
): (config: { token?: unknown; app?: unknown }, ctx: z.RefinementCtx) => void {
  const quantity = required ? 'exactly' : 'at most'
  return (config, ctx) => {
    const hasToken = config.token !== undefined && config.token !== null
    const hasApp = config.app !== undefined && config.app !== null
    if (hasToken && hasApp) {
      ctx.addIssue({
        code: 'custom',
        message: `GitHub auth takes ${quantity} one of token or app; got both`,
      })
    } else if (required && !hasToken && !hasApp) {
      ctx.addIssue({
        code: 'custom',
        message: `GitHub auth takes ${quantity} one of token or app; got neither`,
      })
    }
  }
}

export const GitHubConfig = z
  .object({
    ...TimeoutConfig.shape,
    token: secretStr()
      .nullish()
      .describe(
        'GitHub token: a personal access token, an OAuth token or an App installation token. At most one of `token` and `app` is set; with neither, the mount reads a public repository anonymously.',
      ),
    app: GitHubAppAuth.nullish().describe(
      'A GitHub App installation mirage mints and refreshes tokens for. At most one of `token` and `app` is set; with neither, the mount reads a public repository anonymously.',
    ),
    owner: z.string().describe('Repository owner, a user or an organization.'),
    repo: z.string().describe('Repository name.'),
    ref: z
      .string()
      .nullish()
      .describe(
        "Branch, tag or commit SHA the mount reads. Unset uses the repository's default branch, resolved on first use.",
      ),
    baseUrl: z.string().nullish().meta({
      description: 'GitHub API root; set it for GitHub Enterprise.',
      default: 'https://api.github.com',
    }),
  })
  .superRefine(checkAuth(false))

export type GitHubConfig = ConfigOf<typeof GitHubConfig>

export const GhConfig = z
  .object({
    ...TimeoutConfig.shape,
    token: secretStr().optional(),
    app: GitHubAppAuth.optional(),
    baseUrl: z.string().optional(),
    repo: z.string().optional(),
    branch: z.string().optional(),
  })
  .superRefine(checkAuth(true))

// Derived, not declared twice. The schema is the one doing real work --
// it validates an install's config and carries the `secretStr` marker
// redaction reads -- so a hand-written twin only adds a shape that can
// drift from it, which is how `branch` reached the schema and not the type.
export type GhConfig = ConfigOf<typeof GhConfig>
