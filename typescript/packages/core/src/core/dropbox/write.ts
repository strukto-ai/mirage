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

import { ByteSpool } from '../../io/spool.ts'
import type { ByteSource } from '../../io/types.ts'
import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import { nativeCondition, writeCondition } from '../../cache/context.ts'
import { record, startOp } from '../../observe/context.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { uploadStat } from '../../utils/upload.ts'
import { lookup, refused, type DropboxEntry } from './api.ts'
import { liveOf } from './fingerprint.ts'
import { dropboxUpload } from './client.ts'
import { dropboxPathOf } from './paths.ts'
import { statFromEntry } from './readdir.ts'

// Large spooled inputs use upload sessions. A held version costs one
// get_metadata and goes out as the file's rev in `update` mode. Answers the
// stored file's stat, null for a reply that names none.
export async function write(
  accessor: DropboxAccessor,
  path: PathSpec,
  data: Uint8Array | ByteSpool,
): Promise<FileStat | null> {
  const tm = accessor.tokenManager
  const apiPath = dropboxPathOf(accessor, path)
  const cond = await writeCondition(path, 'put')
  let rev: string | null = null
  if (cond?.ifMatch !== undefined && cond.ifMatch !== '') {
    rev = await nativeCondition(path, cond, liveOf(await lookup(tm, apiPath)), 'put')
  }
  const timer = startOp()
  let entry: unknown
  try {
    entry = await dropboxUpload(tm, apiPath, data, rev)
  } catch (err) {
    throw (await refused(path, err, cond, rev)) ?? err
  }
  const stored = uploadStat(entry as DropboxEntry | null, statFromEntry, path.virtual)
  record(
    'write',
    path.virtual,
    'dropbox',
    data instanceof ByteSpool ? data.size : data.byteLength,
    timer,
    {
      fingerprint: stored?.fingerprint ?? null,
    },
  )
  return stored
}

export async function writeStream(
  accessor: DropboxAccessor,
  path: PathSpec,
  data: ByteSource,
): Promise<FileStat | null> {
  const spool = new ByteSpool()
  try {
    await spool.fill(data)
    return await write(accessor, path, spool)
  } finally {
    await spool.close()
  }
}
