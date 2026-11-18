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

import { FlagView } from '../../../../spec/flag_view.ts'
import { getPage, getPageMarkdown } from '../../../../../core/notion/pages.ts'
import { stringify } from 'yaml'
import { asObject } from '../../../../../utils/records.ts'
import { compareCodePoints } from '../../../../../utils/sort.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../../config.ts'
import type { PathSpec } from '../../../../../types.ts'
import { plainTextOf } from '../../../../../core/notion/normalize.ts'
import { firstText, notionTransport, prettyJson, usageError, type NtnAccessor } from '../util.ts'

const ENC = new TextEncoder()

function propertyValue(prop: Record<string, unknown>): unknown {
  const kind = prop.type
  if (typeof kind !== 'string') return null
  const value = prop[kind] ?? null
  if (kind === 'title' || kind === 'rich_text') return plainTextOf(value)
  if (['select', 'status', 'created_by', 'last_edited_by'].includes(kind)) {
    const item = asObject(value)
    return item.name ?? item.id ?? null
  }
  if (['multi_select', 'people', 'files', 'relation'].includes(kind) && Array.isArray(value)) {
    return value.map(asObject).map((item) => item.name ?? item.id ?? null)
  }
  if ((kind === 'formula' || kind === 'rollup') && value !== null)
    return propertyValue(asObject(value))
  return value
}

export async function get(
  accessor: NtnAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  let pageId: string
  try {
    pageId = firstText(texts, 'page id')
  } catch (err) {
    return usageError(err)
  }
  const transport = notionTransport(accessor, ctx.flags)
  // The Markdown endpoint omits the properties printed in the frontmatter.
  const rendered = await getPageMarkdown(transport, pageId)
  const page = await getPage(transport, pageId)
  if (fl.asBool('json')) return [prettyJson({ markdown: rendered, page }), new IOResult()]
  const body = typeof rendered.markdown === 'string' ? rendered.markdown : ''
  const fields = Object.fromEntries(
    Object.entries(asObject(page.properties)).map(([key, prop]) => [
      key,
      propertyValue(asObject(prop)),
    ]),
  )
  const frontmatter = stringify(fields, {
    sortMapEntries: (a, b) => compareCodePoints(String(a.key), String(b.key)),
    indentSeq: false,
    singleQuote: true,
    lineWidth: 0,
  })
  return [ENC.encode(`---\n${frontmatter}---\n\n${body}`), new IOResult()]
}
