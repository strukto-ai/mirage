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

import { mountKey, mountPrefixOf } from './utils/key_prefix.ts'
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
  wordText,
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
  it('exposes the documented backend kinds with matching string values', () => {
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
    expect(ResourceName.MINIO).toBe('minio')
    expect(ResourceName.CEPH).toBe('ceph')
    expect(ResourceName.SEAWEEDFS).toBe('seaweedfs')
    expect(ResourceName.WASABI).toBe('wasabi')
    expect(ResourceName.BACKBLAZE).toBe('backblaze')
    expect(ResourceName.DIGITALOCEAN).toBe('digitalocean')
    expect(ResourceName.TENCENT).toBe('tencent')
    expect(ResourceName.ALIYUN).toBe('aliyun')
    expect(ResourceName.SCALEWAY).toBe('scaleway')
    expect(ResourceName.QINGSTOR).toBe('qingstor')
  })

  it('contains exactly 47 entries', () => {
    expect(Object.keys(ResourceName)).toHaveLength(47)
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
    expect(p.virtual).toBe('/a/b/c.txt')
    expect(p.directory).toBe('/a/b/')
    expect(mountPrefixOf(p.virtual, p.resourcePath)).toBe('')
    expect(p.resolved).toBe(true)
    expect(p.pattern).toBeNull()
  })

  it('treats a path with no slash as having root directory', () => {
    const p = PathSpec.fromStrPath('c.txt')
    expect(p.virtual).toBe('c.txt')
    expect(p.directory).toBe('/')
  })

  it('treats root / as its own directory', () => {
    const p = PathSpec.fromStrPath('/')
    expect(p.virtual).toBe('/')
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
    const p = PathSpec.fromStrPath(
      '/mnt/s3/data/x.json',
      mountKey('/mnt/s3/data/x.json', '/mnt/s3'),
    )
    expect(mountPrefixOf(p.virtual, p.resourcePath)).toBe('/mnt/s3')
  })
})

describe('PathSpec.mountPath', () => {
  it('removes a matching prefix', () => {
    const p = PathSpec.fromStrPath(
      '/mnt/s3/data/x.json',
      mountKey('/mnt/s3/data/x.json', '/mnt/s3'),
    )
    expect(p.mountPath).toBe('/data/x.json')
  })

  it('returns "/" when original equals the prefix exactly', () => {
    const p = PathSpec.fromStrPath('/mnt/s3', mountKey('/mnt/s3', '/mnt/s3'))
    expect(p.mountPath).toBe('/')
  })

  it('leaves path untouched when prefix does not match', () => {
    const p = PathSpec.fromStrPath('/other/data', mountKey('/other/data', '/mnt/s3'))
    expect(p.mountPath).toBe('/other/data')
  })

  it('leaves path untouched when prefix is empty', () => {
    const p = PathSpec.fromStrPath('/a/b')
    expect(p.mountPath).toBe('/a/b')
  })
})

describe('PathSpec.key', () => {
  it('strips leading and trailing slashes from the prefix-stripped path', () => {
    const p = PathSpec.fromStrPath('/a/b/c.txt')
    expect(p.resourcePath).toBe('a/b/c.txt')
  })

  it('returns empty string for the root path', () => {
    const p = PathSpec.fromStrPath('/')
    expect(p.resourcePath).toBe('')
  })

  it('uses stripPrefix as its source', () => {
    const p = PathSpec.fromStrPath('/mnt/s3/data/', mountKey('/mnt/s3/data/', '/mnt/s3'))
    expect(p.resourcePath).toBe('data')
  })
})

describe('PathSpec.dir', () => {
  it('returns a PathSpec whose original is the directory and resolved is false', () => {
    const p = PathSpec.fromStrPath('/a/b/c.txt')
    const d = p.dir
    expect(d.virtual).toBe('/a/b/')
    expect(d.directory).toBe('/a/b/')
    expect(d.resolved).toBe(false)
  })

  it('carries the pattern through', () => {
    const p = new PathSpec({
      resourcePath: 'a/b/*.txt',
      virtual: '/a/b/*.txt',
      directory: '/a/b/',
      pattern: '*.txt',
    })
    expect(p.dir.pattern).toBe('*.txt')
  })

  it('carries the prefix through', () => {
    const p = PathSpec.fromStrPath('/mnt/s3/data/x', mountKey('/mnt/s3/data/x', '/mnt/s3'))
    expect(mountPrefixOf(p.dir.virtual, p.dir.resourcePath)).toBe('/mnt/s3')
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

describe('PathSpec.mountPath / key', () => {
  it('strips the mount prefix at a path boundary', () => {
    const p = new PathSpec({
      virtual: '/data/sub/x.txt',
      directory: '/data/sub',
      resourcePath: mountKey('/data/sub/x.txt', '/data'),
    })
    expect(p.mountPath).toBe('/sub/x.txt')
    expect(p.resourcePath).toBe('sub/x.txt')
  })

  it('does not strip a sibling that only shares the prefix as a string', () => {
    // `/data` must not be stripped from `/database`, which shares it as a
    // string prefix but not a path prefix.
    const p = new PathSpec({
      virtual: '/database/x.txt',
      directory: '/database',
      resourcePath: mountKey('/database/x.txt', '/data'),
    })
    expect(p.mountPath).toBe('/database/x.txt')
    expect(p.resourcePath).toBe('database/x.txt')
  })

  it('reduces to "/" and empty key at the mount root', () => {
    const p = new PathSpec({
      virtual: '/data',
      directory: '/data',
      resourcePath: mountKey('/data', '/data'),
    })
    expect(p.mountPath).toBe('/')
    expect(p.resourcePath).toBe('')
  })

  it('is identity without a prefix', () => {
    const p = new PathSpec({
      resourcePath: 'x.txt',
      virtual: '/x.txt',
      directory: '/',
    })
    expect(p.mountPath).toBe('/x.txt')
    expect(p.resourcePath).toBe('x.txt')
  })
})

describe('wordText', () => {
  it('passes strings through', () => {
    expect(wordText('plain')).toBe('plain')
  })

  it('renders paths as typed', () => {
    const p = new PathSpec({
      resourcePath: 'a.txt',
      virtual: '/data/a.txt',
      directory: '/data/',
      rawPath: 'a.txt',
    })
    expect(wordText(p)).toBe('a.txt')
  })
})
