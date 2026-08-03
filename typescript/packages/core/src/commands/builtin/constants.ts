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

export enum PatternType {
  EXACT = 'exact',
  SIMPLE = 'simple',
  REGEX = 'regex',
}

// GNU `file -i` reports a symlink by its inode type, never by whatever
// the target would have sniffed as.
export const MIME_SYMLINK = 'inode/symlink; charset=binary'

export const FILE_MIME_MAP: Readonly<Record<string, string>> = Object.freeze({
  text: 'text/plain; charset=us-ascii',
  json: 'application/json; charset=us-ascii',
  csv: 'text/csv; charset=us-ascii',
  directory: 'inode/directory',
  binary: 'application/octet-stream',
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'application/zip': 'application/zip',
  'application/gzip': 'application/gzip',
  'application/pdf': 'application/pdf',
  parquet: 'application/octet-stream',
  orc: 'application/octet-stream',
  feather: 'application/octet-stream',
  hdf5: 'application/octet-stream',
})
