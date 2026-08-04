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

import {
  HttpLinearTransport,
  resolveIssueId,
  listTeams,
  listTeamLabels,
  listTeamProjects,
} from '../../../../core/linear/_client.ts'
import type { LinearTransport } from '../../../../core/linear/_client.ts'
import type { LinearConfig } from '../../../../core/linear/config.ts'
import { materialize, type ByteSource } from '../../../../io/types.ts'
import { enoent } from '../../../../utils/errors.ts'

const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/
const DEC = new TextDecoder()

export function linearTransport(config: unknown): LinearTransport {
  const cfg = config as LinearConfig
  return new HttpLinearTransport({
    apiKey: cfg.apiKey,
    ...(cfg.baseUrl !== undefined && cfg.baseUrl !== '' ? { baseUrl: cfg.baseUrl } : {}),
  })
}

export function firstText(texts: readonly string[], label: string): string {
  const value = texts[0]
  if (value === undefined || value === '') throw new Error(`${label} is required`)
  return value
}

export async function resolveIssue(transport: LinearTransport, token: string): Promise<string> {
  if (ISSUE_KEY_RE.test(token)) return resolveIssueId(transport, null, token)
  return token
}

export async function resolveStateId(
  transport: LinearTransport,
  stateId: string | null | undefined,
  stateName: string | null | undefined,
): Promise<string> {
  if (stateId !== undefined && stateId !== null && stateId !== '') return stateId
  if (stateName === undefined || stateName === null || stateName === '') {
    throw new Error('--state-id or --state-name is required')
  }
  const teams = await listTeams(transport)
  for (const team of teams) {
    const states = team.states
    const nodes =
      states !== null && typeof states === 'object'
        ? ((states as Record<string, unknown>).nodes as Record<string, unknown>[] | undefined)
        : undefined
    for (const state of nodes ?? []) {
      if (state.name === stateName && typeof state.id === 'string') return state.id
    }
  }
  throw enoent(stateName)
}

export async function resolveLabelId(
  transport: LinearTransport,
  teamId: string,
  labelId: string | null | undefined,
  labelName: string | null | undefined,
): Promise<string> {
  if (labelId !== undefined && labelId !== null && labelId !== '') return labelId
  if (labelName === undefined || labelName === null || labelName === '') {
    throw new Error('--label or --label-name is required')
  }
  for (const label of await listTeamLabels(transport, teamId)) {
    if (label.name === labelName && typeof label.id === 'string') return label.id
  }
  throw enoent(labelName)
}

export async function resolveProjectId(
  transport: LinearTransport,
  teamId: string,
  projectId: string | null | undefined,
  projectName: string | null | undefined,
): Promise<string> {
  if (projectId !== undefined && projectId !== null && projectId !== '') return projectId
  if (projectName === undefined || projectName === null || projectName === '') {
    throw new Error('--project or --project-name is required')
  }
  for (const project of await listTeamProjects(transport, teamId)) {
    if (project.name === projectName && typeof project.id === 'string') return project.id
  }
  throw enoent(projectName)
}

export async function textOrStdin(
  inlineText: string | null | undefined,
  stdin: ByteSource | null,
  errorMessage: string,
): Promise<string> {
  if (inlineText !== undefined && inlineText !== null && inlineText !== '') return inlineText
  if (stdin !== null) {
    // Piped text ends with the pipe's newline (echo body | ...); the
    // API body should not.
    return DEC.decode(await materialize(stdin)).replace(/\n+$/, '')
  }
  throw new Error(errorMessage)
}
