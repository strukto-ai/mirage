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

import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { DEFAULT_SCOPE } from '@struktoai/mirage-core/resources/constants'
import { ResourceError } from '@struktoai/mirage-core/resources/errors'
import { RecordResourceStore } from '@struktoai/mirage-core/resources/store'
import type {
  EntryKind,
  Fields,
  ResourceRecords,
  Sealer,
} from '@struktoai/mirage-core/resources/types'
import { parse, stringify } from 'yaml'
import { resourcesRootPath } from '../paths.ts'

/** The folder under the root that holds sealed values, apart from the records. */
const SEALED_DIR = '.sealed'

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

async function unlinkIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/**
 * Write `text` to `path` whole: a temp file created with `mode`, synced,
 * then renamed over it, so a reader never sees a torn file and a sealed one
 * is never readable by others, not even while written.
 */
async function writeWhole(path: string, text: string, mode: number, dirMode: number) {
  await mkdir(dirname(path), { recursive: true, mode: dirMode })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmp, 'wx', mode)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
  } catch (err) {
    await unlinkIfPresent(tmp)
    throw err
  }
}

/** Each record a YAML file at `<root>/<folder>/<name>.yaml`. */
class FileRecords implements ResourceRecords {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  private path(folder: string, name: string): string {
    return join(this.root, folder, `${name}.yaml`)
  }

  async read(folder: string, name: string): Promise<Fields | null> {
    const path = this.path(folder, name)
    const text = await readOrNull(path)
    if (text === null) return null
    const record: unknown = parse(text)
    if (record === null || typeof record !== 'object' || Array.isArray(record))
      throw new ResourceError('invalid', `${path} is not a mapping`)
    return record as Fields
  }

  async write(folder: string, name: string, record: Fields): Promise<void> {
    await writeWhole(this.path(folder, name), stringify(record), 0o644, 0o755)
  }

  remove(folder: string, name: string): Promise<boolean> {
    return unlinkIfPresent(this.path(folder, name))
  }

  async names(folder: string): Promise<string[]> {
    let files: string[]
    try {
      files = await readdir(join(this.root, folder))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return files.filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -'.yaml'.length))
  }
}

/** Each entry's sealed values a JSON file at `<root>/<kind>/<name>.json`, mode 0600 in 0700 folders. */
class FileSealer implements Sealer {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  private path(kind: EntryKind, name: string): string {
    return join(this.root, kind, `${name}.json`)
  }

  async read(kind: EntryKind, name: string): Promise<Fields> {
    const path = this.path(kind, name)
    const text = await readOrNull(path)
    if (text === null) return {}
    const values: unknown = JSON.parse(text)
    if (values === null || typeof values !== 'object' || Array.isArray(values))
      throw new ResourceError('invalid', `${path} is not an object`)
    return values as Fields
  }

  async write(kind: EntryKind, name: string, values: Fields): Promise<void> {
    if (Object.keys(values).length === 0) {
      await this.wipe(kind, name)
      return
    }
    await writeWhole(this.path(kind, name), JSON.stringify(values), 0o600, 0o700)
  }

  async wipe(kind: EntryKind, name: string): Promise<void> {
    await unlinkIfPresent(this.path(kind, name))
  }
}

/** The local daemon's store: records under `root`, sealed values under `root/.sealed`. */
export function filesResourceStore(root: string = resourcesRootPath()): ResourceStore {
  return new RecordResourceStore(
    DEFAULT_SCOPE,
    new FileRecords(root),
    new FileSealer(join(root, SEALED_DIR)),
  )
}
