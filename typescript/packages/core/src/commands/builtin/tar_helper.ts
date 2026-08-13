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

import { packTar, unpackTar, type TarHeader } from 'modern-tar'

const DIR_MODE = 0o755
const LINK_MODE = 0o777
const FILE_MODE = 0o644

export interface TarEntry {
  name: string
  data: Uint8Array
  isFile: boolean
  // Directories carry no content and a trailing slash; a symlink carries
  // its target in the header's linkname field instead of any content.
  isDir?: boolean
  linkname?: string
}

function headerOf(entry: TarEntry): TarHeader {
  if (entry.isDir === true) {
    // A directory member is spelled with a trailing slash; that slash is
    // what tells every extractor it holds no content.
    const name = entry.name.endsWith('/') ? entry.name : `${entry.name}/`
    return { name, size: 0, type: 'directory', mode: DIR_MODE }
  }
  const linkname = entry.linkname ?? ''
  if (linkname !== '') {
    return { name: entry.name, size: 0, type: 'symlink', mode: LINK_MODE, linkname }
  }
  return { name: entry.name, size: entry.data.byteLength, type: 'file', mode: FILE_MODE }
}

export async function writeTar(entries: readonly TarEntry[]): Promise<Uint8Array> {
  // A directory and a symlink record their identity in the header and
  // occupy no data blocks, whatever the caller put in `data`.
  return packTar(
    entries.map((entry) => {
      const header = headerOf(entry)
      return header.type === 'file' ? { header, body: entry.data } : { header }
    }),
  )
}

export async function readTar(data: Uint8Array): Promise<TarEntry[]> {
  const parsed = await unpackTar(data)
  return parsed.map((entry) => {
    // A trailing slash marks a directory even on an archive written
    // before ustar typeflags (GNU tar has always spelled it that way).
    const isDir = entry.header.type === 'directory' || entry.header.name.endsWith('/')
    return {
      name: entry.header.name,
      data: entry.data ?? new Uint8Array(0),
      isFile: entry.header.type === 'file' && !isDir,
      isDir,
      linkname: entry.header.linkname ?? '',
    }
  })
}
