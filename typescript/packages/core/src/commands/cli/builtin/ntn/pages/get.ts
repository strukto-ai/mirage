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
import { extractTitle } from '../../../../../core/notion/normalize.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../../config.ts'
import type { PathSpec } from '../../../../../types.ts'
import { firstText, notionTransport, prettyJson, usageError, type NtnAccessor } from '../util.ts'

const ENC = new TextEncoder()

export async function get(
  accessor: NtnAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  let pageId: string
  try {
    pageId = firstText(texts, 'page id')
  } catch (err) {
    return usageError(err)
  }
  const transport = notionTransport(accessor, ctx.flags)
  // Both calls happen either way: the body comes from the markdown endpoint
  // and the title heading the frontmatter only exists on the page object.
  const rendered = await getPageMarkdown(transport, pageId)
  const page = await getPage(transport, pageId)
  if (fl.asBool('json')) return [prettyJson({ markdown: rendered, page }), new IOResult()]
  const body = typeof rendered.markdown === 'string' ? rendered.markdown : ''
  return [ENC.encode(`---\ntitle: ${extractTitle(page)}\n---\n\n${body}`), new IOResult()]
}
