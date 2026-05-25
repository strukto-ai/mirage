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

import { describe, expect, it } from 'vitest'
import {
  ConsistencyPolicy,
  DEFAULT_AGENT_ID,
  DEFAULT_SESSION_ID,
  FileStat,
  FileType,
  MountMode,
  PathSpec,
  ResourceName,
} from './types.ts'

describe('MountMode', () => {
  it('exposes READ/WRITE/EXEC with matching string values', () => {
    expect(MountMode.READ).toBe('read')
    expect(MountMode.WRITE).toBe('write')
    expect(MountMode.EXEC).toBe('exec')
  })

  it('is frozen at runtime', () => {
    expect(Object.isFrozen(MountMode)).toBe(true)
  })
})

describe('ConsistencyPolicy', () => {
  it('exposes LAZY/ALWAYS with matching string values', () => {
    expect(ConsistencyPolicy.LAZY).toBe('lazy')
    expect(ConsistencyPolicy.ALWAYS).toBe('always')
  })

  it('is frozen at runtime', () => {
    expect(Object.isFrozen(ConsistencyPolicy)).toBe(true)
  })
})

describe('ResourceName', () => {
  it('exposes the 24 documented backend kinds with matching string values', () => {
    expect(ResourceName.DISK).toBe('disk')
    expect(ResourceName.S3).toBe('s3')
    expect(ResourceName.RAM).toBe('ram')
    expect(ResourceName.GITHUB).toBe('github')
    expect(ResourceName.LINEAR).toBe('linear')
    expect(ResourceName.GDOCS).toBe('gdocs')
    expect(ResourceName.GSHEETS).toBe('gsheets')
    expect(ResourceName.GSLIDES).toBe('gslides')
    expect(ResourceName.GDRIVE).toBe('gdrive')
    expect(ResourceName.SLACK).toBe('slack')
    expect(ResourceName.DISCORD).toBe('discord')
    expect(ResourceName.GMAIL).toBe('gmail')
    expect(ResourceName.TRELLO).toBe('trello')
    expect(ResourceName.TELEGRAM).toBe('telegram')
    expect(ResourceName.MONGODB).toBe('mongodb')
    expect(ResourceName.NOTION).toBe('notion')
    expect(ResourceName.LANGFUSE).toBe('langfuse')
    expect(ResourceName.SSH).toBe('ssh')
    expect(ResourceName.REDIS).toBe('redis')
    expect(ResourceName.GITHUB_CI).toBe('github_ci')
    expect(ResourceName.GCS).toBe('gcs')
    expect(ResourceName.EMAIL).toBe('email')
    expect(ResourceName.OPFS).toBe('opfs')
    expect(ResourceName.SUPABASE).toBe('supabase')
    expect(ResourceName.POSTGRES).toBe('postgres')
  })

  it('contains exactly 33 entries', () => {
    expect(Object.keys(ResourceName)).toHaveLength(33)
  })

  it('is frozen at runtime', () => {
    expect(Object.isFrozen(ResourceName)).toBe(true)
  })
})

describe('default id constants', () => {
  it('DEFAULT_SESSION_ID is "default"', () => {
    expect(DEFAULT_SESSION_ID).toBe('default')
  })

  it('DEFAULT_AGENT_ID is "default"', () => {
    expect(DEFAULT_AGENT_ID).toBe('default')
  })
})

describe('FileType', () => {
  it('exposes the documented enum values', () => {
    expect(FileType.DIRECTORY).toBe('directory')
    expect(FileType.TEXT).toBe('text')
    expect(FileType.BINARY).toBe('binary')
    expect(FileType.JSON).toBe('json')
    expect(FileType.CSV).toBe('csv')
    expect(FileType.IMAGE_PNG).toBe('image/png')
    expect(FileType.IMAGE_JPEG).toBe('image/jpeg')
    expect(FileType.IMAGE_GIF).toBe('image/gif')
    expect(FileType.ZIP).toBe('application/zip')
    expect(FileType.GZIP).toBe('application/gzip')
    expect(FileType.PDF).toBe('application/pdf')
    expect(FileType.PARQUET).toBe('parquet')
    expect(FileType.ORC).toBe('orc')
    expect(FileType.FEATHER).toBe('feather')
    expect(FileType.HDF5).toBe('hdf5')
  })

  it('is frozen at runtime', () => {
    expect(Object.isFrozen(FileType)).toBe(true)
  })
})

describe('FileStat', () => {
  it('fills defaults when only name is provided', () => {
    const s = new FileStat({ name: 'x.txt' })
    expect(s.name).toBe('x.txt')
    expect(s.size).toBeNull()
    expect(s.modified).toBeNull()
    expect(s.fingerprint).toBeNull()
    expect(s.type).toBeNull()
    expect(s.extra).toEqual({})
  })

  it('keeps all fields provided at construction', () => {
    const s = new FileStat({
      name: 'x.json',
      size: 1024,
      modified: '2026-04-18T00:00:00Z',
      fingerprint: 'abc123',
      type: FileType.JSON,
      extra: { etag: 'W/"abc"' },
    })
    expect(s.size).toBe(1024)
    expect(s.modified).toBe('2026-04-18T00:00:00Z')
    expect(s.fingerprint).toBe('abc123')
    expect(s.type).toBe(FileType.JSON)
    expect(s.extra).toEqual({ etag: 'W/"abc"' })
  })

  it('is frozen at the top level', () => {
    const s = new FileStat({ name: 'x' })
    expect(Object.isFrozen(s)).toBe(true)
  })
})

describe('PathSpec.fromStrPath', () => {
  it('splits a nested path into directory + original', () => {
    const p = PathSpec.fromStrPath('/a/b/c.txt')
    expect(p.original).toBe('/a/b/c.txt')
    expect(p.directory).toBe('/a/b/')
    expect(p.prefix).toBe('')
    expect(p.resolved).toBe(true)
    expect(p.pattern).toBeNull()
  })

  it('treats a path with no slash as having root directory', () => {
    const p = PathSpec.fromStrPath('c.txt')
    expect(p.original).toBe('c.txt')
    expect(p.directory).toBe('/')
  })

  it('treats root / as its own directory', () => {
    const p = PathSpec.fromStrPath('/')
    expect(p.original).toBe('/')
    expect(p.directory).toBe('/')
  })

  it('treats top-level /a as having root directory', () => {
    const p = PathSpec.fromStrPath('/a')
    expect(p.directory).toBe('/')
  })

  it('treats empty path as root directory', () => {
    const p = PathSpec.fromStrPath('')
    expect(p.directory).toBe('/')
  })

  it('carries the prefix through construction', () => {
    const p = PathSpec.fromStrPath('/mnt/s3/data/x.json', '/mnt/s3')
    expect(p.prefix).toBe('/mnt/s3')
  })
})

describe('PathSpec.stripPrefix', () => {
  it('removes a matching prefix', () => {
    const p = PathSpec.fromStrPath('/mnt/s3/data/x.json', '/mnt/s3')
    expect(p.stripPrefix).toBe('/data/x.json')
  })

  it('returns "/" when original equals the prefix exactly', () => {
    const p = PathSpec.fromStrPath('/mnt/s3', '/mnt/s3')
    expect(p.stripPrefix).toBe('/')
  })

  it('leaves path untouched when prefix does not match', () => {
    const p = PathSpec.fromStrPath('/other/data', '/mnt/s3')
    expect(p.stripPrefix).toBe('/other/data')
  })

  it('leaves path untouched when prefix is empty', () => {
    const p = PathSpec.fromStrPath('/a/b')
    expect(p.stripPrefix).toBe('/a/b')
  })
})

describe('PathSpec.key', () => {
  it('strips leading and trailing slashes from the prefix-stripped path', () => {
    const p = PathSpec.fromStrPath('/a/b/c.txt')
    expect(p.key).toBe('a/b/c.txt')
  })

  it('returns empty string for the root path', () => {
    const p = PathSpec.fromStrPath('/')
    expect(p.key).toBe('')
  })

  it('uses stripPrefix as its source', () => {
    const p = PathSpec.fromStrPath('/mnt/s3/data/', '/mnt/s3')
    expect(p.key).toBe('data')
  })
})

describe('PathSpec.dir', () => {
  it('returns a PathSpec whose original is the directory and resolved is false', () => {
    const p = PathSpec.fromStrPath('/a/b/c.txt')
    const d = p.dir
    expect(d.original).toBe('/a/b/')
    expect(d.directory).toBe('/a/b/')
    expect(d.resolved).toBe(false)
  })

  it('carries the pattern through', () => {
    const p = new PathSpec({
      original: '/a/b/*.txt',
      directory: '/a/b/',
      pattern: '*.txt',
    })
    expect(p.dir.pattern).toBe('*.txt')
  })

  it('carries the prefix through', () => {
    const p = PathSpec.fromStrPath('/mnt/s3/data/x', '/mnt/s3')
    expect(p.dir.prefix).toBe('/mnt/s3')
  })
})

describe('PathSpec.child', () => {
  it('appends a child name, stripping trailing slashes from original first', () => {
    const p = PathSpec.fromStrPath('/a/b/')
    expect(p.child('c.txt')).toBe('/a/b/c.txt')
  })

  it('appends a child name directly when no trailing slash', () => {
    const p = PathSpec.fromStrPath('/a/b')
    expect(p.child('c.txt')).toBe('/a/b/c.txt')
  })
})

describe('PathSpec immutability', () => {
  it('is frozen after construction', () => {
    const p = PathSpec.fromStrPath('/a')
    expect(Object.isFrozen(p)).toBe(true)
  })
})
