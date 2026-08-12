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

import { HttpGitHubTransport, type GitHubTransport } from '../../../../core/github/_client.ts'
import type { GhConfig } from '../../../../core/github/config.ts'
import { parseRepo, type RepoRef } from '../../../../core/github/repo.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'

const ENC = new TextEncoder()

export function ghTransport(config: unknown): GitHubTransport {
  const cfg = config as GhConfig
  const opts: { token: string; baseUrl?: string } = { token: cfg.token }
  if (cfg.baseUrl !== undefined) opts.baseUrl = cfg.baseUrl
  return new HttpGitHubTransport(opts)
}

/**
 * The repository a line is about: the operand if it named one, the
 * install's own otherwise. gh resolves this from the current git remote,
 * which a workspace has no equivalent of, so the config carries it.
 */
export function ghRepo(config: unknown, spec: string | undefined): RepoRef {
  const named = spec ?? (config as GhConfig).repo
  if (named === undefined || named === '') {
    throw new Error('no repository given; pass one or set `repo` on the install')
  }
  return parseRepo(named)
}

export function jsonOut(value: unknown): CommandFnResult {
  const text = value === null ? '' : `${JSON.stringify(value, null, 2)}\n`
  const out: ByteSource = ENC.encode(text)
  return [out, new IOResult()]
}

export function textOut(text: string): CommandFnResult {
  const out: ByteSource = ENC.encode(text)
  return [out, new IOResult()]
}
