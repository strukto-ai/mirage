import { PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { nextcloudKey } from './util.ts'

function mounted(virtual: string, vfsPath: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath })
}

describe('nextcloudKey', () => {
  it.each([
    ['/nc/docs/a.txt', 'docs/a.txt', 'docs/a.txt'],
    ['/nc', '', ''],
    ['/nc/', '', ''],
    ['/nc/docs/', 'docs', 'docs/'],
    ['/nc/docs/a.txt/', 'docs/a.txt', 'docs/a.txt/'],
    ['/a.txt', 'a.txt', 'a.txt'],
  ])('%s (key %s) drops the mount prefix', (virtual, vfsPath, key) => {
    expect(nextcloudKey(mounted(virtual, vfsPath))).toBe(key)
  })
})
