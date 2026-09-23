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
  compressionRatio,
  renderHeader,
  renderRow,
  renderTotals,
  zipinfoLayout,
  type ZipinfoLayout,
  type ZipinfoRequest,
  type ZipRow,
} from './zipinfo.ts'

const STAMP: ZipRow['dateTime'] = [2026, 9, 20, 7, 33, 0]

function row(over: Partial<ZipRow> = {}): ZipRow {
  return {
    name: 'document.txt',
    size: 5,
    csize: 5,
    method: 0,
    flags: 0,
    internalAttr: 0,
    externalAttr: (0o600 << 16) >>> 0,
    host: 3,
    hostVersion: 20,
    dateTime: STAMP,
    hasExtra: false,
    ...over,
  }
}

describe('zipinfo rows', () => {
  it('renders the short row as Info-ZIP does', () => {
    expect(renderRow(row(), 'short')).toBe(
      '?rw-------  2.0 unx        5 b- stor 26-Sep-20 07:33 document.txt',
    )
  })

  it('adds the compressed size under -l', () => {
    const r = row({
      name: 'dir/a.txt',
      size: 200,
      csize: 6,
      method: 8,
      externalAttr: (0o100664 << 16) >>> 0,
    })
    expect(renderRow(r, 'long')).toBe(
      '-rw-rw-r--  2.0 unx      200 b-        6 defN 26-Sep-20 07:33 dir/a.txt',
    )
  })

  it('renders a directory and the deflate level letter', () => {
    const r = row({
      name: 'dir/',
      size: 0,
      csize: 2,
      method: 8,
      flags: 2,
      externalAttr: ((0o40775 << 16) | 0x10) >>> 0,
    })
    expect(renderRow(r, 'short')).toBe('drwxrwxr-x  2.0 unx        0 b- defX 26-Sep-20 07:33 dir/')
  })

  it('renders a zero stamp with a bogus month', () => {
    expect(renderRow(row({ dateTime: [1980, 0, 0, 0, 0, 0] }), 'short')).toMatch(
      / 80-000-00 00:00 document\.txt$/,
    )
  })

  it('renders DOS attributes for a FAT host', () => {
    expect(renderRow(row({ name: 'setup.exe', host: 0, externalAttr: 0x21 }), 'short')).toBe(
      '-r-xa--     2.0 fat        5 b- stor 26-Sep-20 07:33 setup.exe',
    )
  })

  it('renders a Unix mode for a FAT host whose bits shadow the DOS byte', () => {
    expect(
      renderRow(row({ host: 0, externalAttr: ((0o600 << 16) | 0x20) >>> 0 }), 'short'),
    ).toMatch(/^\?rw------- {2}2\.0 fat /)
  })

  it('renders the text, extra, encrypted and descriptor letters', () => {
    expect(renderRow(row({ internalAttr: 1, hasExtra: true }), 'short')).toContain(' tx stor ')
    expect(renderRow(row({ flags: 1 | 8 }), 'short')).toContain(' Bl stor ')
  })

  it('adds the percent saved under -m, truncated toward zero', () => {
    expect(renderRow(row({ name: 'dir/', size: 0, csize: 2, method: 8 }), 'medium')).toBe(
      '?rw-------  2.0 unx        0 b-  0% defN 26-Sep-20 07:33 dir/',
    )
    expect(renderRow(row({ name: 'dir/a.txt', size: 200, csize: 6, method: 8 }), 'medium')).toBe(
      '?rw-------  2.0 unx      200 b- 97% defN 26-Sep-20 07:33 dir/a.txt',
    )
    expect(renderRow(row({ name: 'b.txt', size: 1, csize: 3, method: 8 }), 'medium')).toBe(
      '?rw-------  2.0 unx        1 b--199% defN 26-Sep-20 07:33 b.txt',
    )
  })

  it('renders an unknown method and a host past the table', () => {
    const line = renderRow(row({ method: 99, host: 40 }), 'short')
    expect(line).toContain(' ??? ')
    expect(line).toContain(' u099 ')
  })
})

describe('zipinfo header and totals', () => {
  it('computes the ratio in signed rounded tenths', () => {
    expect(compressionRatio(201, 11)).toBe(945)
    expect(compressionRatio(5, 9)).toBe(-800)
    expect(compressionRatio(4, 6)).toBe(-500)
    expect(compressionRatio(0, 0)).toBe(0)
  })

  it('renders the totals line', () => {
    expect(renderTotals([row()])).toBe('1 file, 5 bytes uncompressed, 5 bytes compressed:  0.0%\n')
    expect(renderTotals([row({ size: 4, csize: 6 }), row({ name: 'd/', size: 0, csize: 0 })])).toBe(
      '2 files, 4 bytes uncompressed, 6 bytes compressed:  -50.0%\n',
    )
  })

  it('does not count an encrypted entry header as compressed data', () => {
    expect(renderTotals([row({ flags: 1, csize: 17 })])).toBe(
      '1 file, 5 bytes uncompressed, 5 bytes compressed:  0.0%\n',
    )
  })

  it('renders the header lines', () => {
    expect(renderHeader('/data/x.zip', 127, 1)).toBe(
      'Archive:  /data/x.zip\nZip file size: 127 bytes, number of entries: 1\n',
    )
  })
})

describe('zipinfo layout', () => {
  function layout(over: Partial<ZipinfoRequest> = {}): ZipinfoLayout {
    return zipinfoLayout({
      namesOnly: false,
      namesHeaders: false,
      long: false,
      medium: false,
      short: false,
      header: false,
      totals: false,
      hasMembers: false,
      ...over,
    })
  }

  it('follows zi_opts', () => {
    expect(layout()).toEqual({ rows: 'short', header: true, totals: true })
    expect(layout({ long: true })).toEqual({ rows: 'long', header: true, totals: true })
    expect(layout({ medium: true })).toEqual({ rows: 'medium', header: true, totals: true })
    expect(layout({ short: true, header: true })).toEqual({
      rows: 'short',
      header: true,
      totals: true,
    })
    expect(layout({ medium: true, hasMembers: true })).toEqual({
      rows: 'medium',
      header: false,
      totals: false,
    })
    expect(layout({ namesOnly: true, header: true, totals: true })).toEqual({
      rows: 'names',
      header: false,
      totals: false,
    })
    expect(layout({ namesHeaders: true, header: true })).toEqual({
      rows: 'names',
      header: true,
      totals: false,
    })
    expect(layout({ header: true })).toEqual({ rows: 'none', header: true, totals: false })
    expect(layout({ totals: true })).toEqual({ rows: 'none', header: false, totals: true })
    expect(layout({ hasMembers: true })).toEqual({ rows: 'short', header: false, totals: false })
    expect(layout({ header: true, hasMembers: true })).toEqual({
      rows: 'short',
      header: true,
      totals: false,
    })
    expect(layout({ namesOnly: true, namesHeaders: true })).toEqual({
      rows: 'names',
      header: false,
      totals: false,
    })
  })
})
