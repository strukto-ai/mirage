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
import { getFileUpload } from '../../../../../core/notion/file_uploads.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../../config.ts'
import type { PathSpec } from '../../../../../types.ts'
import { firstText, notionTransport, uploadOutput, usageError, type NtnAccessor } from '../util.ts'

export async function filesGet(
  accessor: NtnAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  let uploadId: string
  try {
    uploadId = firstText(texts, 'upload id')
  } catch (err) {
    return usageError(err)
  }
  const fl = new FlagView(ctx.flags, ctx.spec)
  const upload = await getFileUpload(notionTransport(accessor, ctx.flags), uploadId)
  return [uploadOutput(upload, fl.asBool('json')), new IOResult()]
}
