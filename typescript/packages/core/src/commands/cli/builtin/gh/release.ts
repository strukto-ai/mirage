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

import { FlagView } from '../../../spec/flag_view.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import type { PathSpec } from '../../../../types.ts'
import {
  createRelease,
  getLatestRelease,
  getRelease,
  listReleases,
} from '../../../../core/github/release.ts'
import {
  bodyValue,
  camel,
  csvValues,
  ghBool,
  ghTransport,
  repoFor,
  textOut,
  textValue,
  typedOut,
} from './accessor.ts'

const RELEASE_FIELDS = [
  'body',
  'createdAt',
  'isDraft',
  'isLatest',
  'isPrerelease',
  'name',
  'publishedAt',
  'tagName',
  'targetCommitish',
  'url',
] as const

function release(value: unknown): Record<string, unknown> {
  const row = camel(value)
  const result = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
  if ('draft' in result) {
    result.isDraft = result.draft
    delete result.draft
  }
  if ('prerelease' in result) {
    result.isPrerelease = result.prerelease
    delete result.prerelease
  }
  result.isLatest ??= false
  return result
}

function listText(rows: Record<string, unknown>[]): string {
  return rows
    .map((row) => {
      const kind = row.isDraft
        ? 'Draft'
        : row.isPrerelease
          ? 'Pre-release'
          : row.isLatest
            ? 'Latest'
            : ''
      return `${textValue(row.name)}\t${textValue(row.tagName)}\t${kind}\t${textValue(row.publishedAt)}\n`
    })
    .join('')
}

export async function listCmd(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const rows = (
    await listReleases(ghTransport(config), repoFor(config, fl), fl.asInt('limit') ?? 30)
  ).map(release)
  const latest = rows.find((row) => !row.isDraft && !row.isPrerelease)
  if (latest !== undefined) latest.isLatest = true
  return typedOut(rows, fl, listText(rows), RELEASE_FIELDS)
}

export async function viewCmd(
  config: unknown,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const tag = texts[0] ?? ''
  if (tag === '') throw new Error('a release tag is required')
  const transport = ghTransport(config)
  const ref = repoFor(config, fl)
  const row = release(await getRelease(transport, ref, tag))
  if (csvValues([fl.asStr('json') ?? '']).includes('isLatest')) {
    const latest = await getLatestRelease(transport, ref)
    const latestRow = latest === null ? {} : release(latest)
    row.isLatest = latestRow.tagName === row.tagName
  }
  const human = `title:\t${textValue(row.name)}\ntag:\t${textValue(row.tagName)}\ndraft:\t${String(Boolean(row.isDraft))}\nprerelease:\t${String(Boolean(row.isPrerelease))}\n--\n${textValue(row.body)}\n`
  return typedOut(row, fl, human, RELEASE_FIELDS)
}

export async function createCmd(
  config: unknown,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const tag = texts[0] ?? ''
  if (tag === '') throw new Error('a release tag is required in noninteractive mode')
  const body: Record<string, unknown> = {
    tag_name: tag,
    name: fl.asStr('title') ?? tag,
    body: (await bodyValue(ctx, fl, { value: 'notes', file: 'notes_file' })) ?? '',
    draft: ghBool(fl, 'draft'),
    prerelease: ghBool(fl, 'prerelease'),
    generate_release_notes: ghBool(fl, 'generate_notes'),
  }
  const target = fl.asStr('target')
  if (target !== undefined) body.target_commitish = target
  const created = release(await createRelease(ghTransport(config), repoFor(config, fl), body))
  return textOut(`${textValue(created.url)}\n`)
}
