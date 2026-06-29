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

import { FileType } from '../types.ts'

const EXTENSION_MAP: Readonly<Record<string, FileType>> = Object.freeze({
  json: FileType.JSON,
  jsonl: FileType.JSON,
  csv: FileType.CSV,
  tsv: FileType.CSV,
  txt: FileType.TEXT,
  md: FileType.TEXT,
  py: FileType.TEXT,
  js: FileType.TEXT,
  ts: FileType.TEXT,
  yaml: FileType.TEXT,
  yml: FileType.TEXT,
  toml: FileType.TEXT,
  png: FileType.IMAGE_PNG,
  jpg: FileType.IMAGE_PNG,
  jpeg: FileType.IMAGE_JPEG,
  gif: FileType.IMAGE_GIF,
  zip: FileType.ZIP,
  gz: FileType.GZIP,
  pdf: FileType.PDF,
  parquet: FileType.PARQUET,
  orc: FileType.ORC,
  feather: FileType.FEATHER,
  arrow: FileType.FEATHER,
  ipc: FileType.FEATHER,
  h5: FileType.HDF5,
  hdf5: FileType.HDF5,
})

export function guessType(path: string): FileType {
  const dot = path.lastIndexOf('.')
  if (dot === -1 || path.slice(dot).includes('/')) return FileType.BINARY
  const ext = path.slice(dot + 1).toLowerCase()
  return EXTENSION_MAP[ext] ?? FileType.BINARY
}

const MIMETYPE_MAP: Readonly<Record<string, FileType>> = Object.freeze({
  'application/pdf': FileType.PDF,
  'application/zip': FileType.ZIP,
  'application/gzip': FileType.GZIP,
  'application/json': FileType.JSON,
  'image/png': FileType.IMAGE_PNG,
  'image/jpeg': FileType.IMAGE_JPEG,
  'image/gif': FileType.IMAGE_GIF,
  'text/csv': FileType.CSV,
})

// Map a standard mimetype to a FileType, TEXT for any text/*, BINARY default.
// Mirrors Python's filetype_from_mimetype.
export function filetypeFromMimetype(mime: string): FileType {
  if (mime === '') return FileType.BINARY
  const mapped = MIMETYPE_MAP[mime]
  if (mapped !== undefined) return mapped
  if (mime.startsWith('text/')) return FileType.TEXT
  return FileType.BINARY
}
