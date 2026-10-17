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
import { replacePageMarkdown } from '../../../../../core/notion/pages.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../../config.ts'
import type { PathSpec } from '../../../../../types.ts'
import { contentOrStdin, firstText, notionTransport, prettyJson, usageError } from '../util.ts'
import type { NtnAccessor } from '../util.ts'

const ENC = new TextEncoder()

export async function edit(
  accessor: NtnAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  let pageId: string
  let markdown: string
  try {
    pageId = firstText(texts, 'page id')
    markdown = await contentOrStdin(fl.asStr('content'), ctx.stdin)
  } catch (err) {
    return usageError(err)
  }
  // The PATCH answers with the page's new markdown, which is what `--json` is
  // for; printing the id under it would throw the response away on the one
  // flag that asks for it.
  const edited = await replacePageMarkdown(notionTransport(accessor, ctx.flags), pageId, markdown)
  if (fl.asBool('json')) return [prettyJson(edited), new IOResult()]
  return [ENC.encode(`${pageId}\n`), new IOResult()]
}
