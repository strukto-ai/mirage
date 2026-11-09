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
import { listFileUploads } from '../../../../../core/notion/file_uploads.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../../config.ts'
import type { PathSpec } from '../../../../../types.ts'
import {
  UPLOAD_COLUMNS,
  notionTransport,
  prettyJson,
  uploadRow,
  type NtnAccessor,
} from '../util.ts'

const ENC = new TextEncoder()
const COLUMNS = UPLOAD_COLUMNS.slice(0, -1)

export async function filesList(
  accessor: NtnAccessor,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const page = await listFileUploads(notionTransport(accessor, ctx.flags))
  const results = (page.results ?? []) as Record<string, unknown>[]
  if (fl.asBool('json')) return [prettyJson(results), new IOResult()]
  const rows = results.map((row) => `${uploadRow(row, COLUMNS)}\n`).join('')
  return [ENC.encode(rows), new IOResult()]
}
