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
import {
  completeFileUpload,
  createFileUpload,
  sendFilePart,
} from '../../../../../core/notion/file_uploads.ts'
import { IOResult, materialize } from '../../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../../config.ts'
import type { PathSpec } from '../../../../../types.ts'
import { mimeTypeFor } from '../../../../../utils/filetype.ts'
import { notionTransport, uploadOutput, type NtnAccessor } from '../util.ts'

const ENC = new TextEncoder()
const DEFAULT_FILENAME = 'upload.bin'
const PART_SIZE = 10 * 1024 * 1024
const NO_BYTES =
  'error: No file bytes were received on stdin.\n' +
  '  hint: Redirect a file, for example: `ntn files create < file.png`.\n'

/** The file name an external URL's path ends in. */
function externalName(url: string): string {
  const afterScheme = url.includes('://') ? url.slice(url.indexOf('://') + 3) : url
  const slash = afterScheme.indexOf('/')
  const path = slash === -1 ? '' : afterScheme.slice(slash + 1)
  const name = path.split('?')[0]?.split('#')[0]?.split('/').pop() ?? ''
  return name === '' ? DEFAULT_FILENAME : name
}

export async function filesCreate(
  accessor: NtnAccessor,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const line = notionTransport(accessor, ctx.flags)
  const named = fl.asStr('filename')
  const contentType = fl.asStr('content_type')
  const external = fl.asStr('external_url')
  const asJson = fl.asBool('json')
  if (external !== undefined) {
    const name = named !== undefined && named !== '' ? named : externalName(external)
    const opened = await createFileUpload(line, {
      mode: 'external_url',
      external_url: external,
      filename: name,
      content_type:
        contentType !== undefined && contentType !== '' ? contentType : mimeTypeFor(name),
    })
    return [uploadOutput(opened, asJson), new IOResult()]
  }
  const data = ctx.stdin !== null ? await materialize(ctx.stdin) : new Uint8Array(0)
  if (data.byteLength === 0) {
    return [null, new IOResult({ exitCode: 5, stderr: ENC.encode(NO_BYTES) })]
  }
  const name = named !== undefined && named !== '' ? named : DEFAULT_FILENAME
  const kind = contentType !== undefined && contentType !== '' ? contentType : mimeTypeFor(name)
  const parts = Math.ceil(data.byteLength / PART_SIZE)
  const opened = await createFileUpload(line, {
    mode: 'multi_part',
    filename: name,
    content_type: kind,
    number_of_parts: parts,
  })
  const uploadId = String(opened.id)
  for (let index = 0; index < parts; index += 1) {
    const chunk = data.subarray(index * PART_SIZE, (index + 1) * PART_SIZE)
    await sendFilePart(line, uploadId, name, kind, chunk, index + 1)
  }
  return [uploadOutput(await completeFileUpload(line, uploadId), asJson), new IOResult()]
}
