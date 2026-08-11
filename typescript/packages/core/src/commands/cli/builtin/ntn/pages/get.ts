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

import { FlagView } from '../../../../spec/types.ts'
import { getPage, getPageMarkdown } from '../../../../../core/notion/pages.ts'
import { extractTitle } from '../../../../../core/notion/normalize.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { CommandFnResult } from '../../../../config.ts'
import type { CLIInvocation } from '../../../types.ts'
import { firstText, notionTransport, prettyJson, usageError } from '../util.ts'

const ENC = new TextEncoder()

export async function get(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  let pageId: string
  try {
    pageId = firstText(inv.texts, 'page id')
  } catch (err) {
    return usageError(err)
  }
  const transport = notionTransport(inv.config, inv.flags)
  // Both calls happen either way: the body comes from the markdown endpoint
  // and the title heading the frontmatter only exists on the page object.
  const rendered = await getPageMarkdown(transport, pageId)
  const page = await getPage(transport, pageId)
  if (fl.asBool('json')) return [prettyJson({ markdown: rendered, page }), new IOResult()]
  const body = typeof rendered.markdown === 'string' ? rendered.markdown : ''
  return [ENC.encode(`---\ntitle: ${extractTitle(page)}\n---\n\n${body}`), new IOResult()]
}
