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

import { ContentType, FileStat, FileType, PathSpec } from '../../../types.ts'
import { enoent } from '../../../utils/errors.ts'
import { UsageError } from '../../errors.ts'
import { truncateGeneric } from './truncate.ts'

function fPath(): PathSpec {
  return new PathSpec({
    virtual: '/f',
    directory: '/',
    vfsPath: 'f',
    resolved: true,
  })
}

async function runTruncate(size: string, current = 10): Promise<number[]> {
  const lengths: number[] = []
  await truncateGeneric(
    [fPath()],
    { size, noCreate: false },
    () =>
      Promise.resolve(
        new FileStat({ name: 'f', type: FileType.FILE, content: ContentType.TEXT, size: current }),
      ),
    (_p, length) => {
      lengths.push(length)
      return Promise.resolve()
    },
  )
  return lengths
}

describe('truncate sizes', () => {
  it('resolves plain and operation sizes', async () => {
    expect(await runTruncate('10', 0)).toEqual([10])
    expect(await runTruncate('%4', 10)).toEqual([12])
  })

  it('accepts the full GNU suffix alphabet', async () => {
    // truncate's letter set is not split's: lowercase g/k/m/t are valid
    // (pinned against coreutils 9.7), and E/P parse fine even though
    // most filesystems refuse the resulting size.
    expect(await runTruncate('1k')).toEqual([1024])
    expect(await runTruncate('1g')).toEqual([1024 ** 3])
    expect(await runTruncate('1t')).toEqual([1024 ** 4])
    expect(await runTruncate('1GiB')).toEqual([1024 ** 3])
    expect(await runTruncate('1GB')).toEqual([1000 ** 3])
    expect(await runTruncate('1mB')).toEqual([1000 ** 2])
    expect(await runTruncate('1E')).toEqual([1024 ** 6])
  })

  it('skips whitespace around the mode character', async () => {
    // GNU skips C-locale whitespace both before and after the mode char,
    // so ` 4` is absolute, ` +4` extends, and `< 4` caps (pinned against
    // coreutils 9.7).
    expect(await runTruncate(' +4', 10)).toEqual([14])
    expect(await runTruncate('\t<\t4', 10)).toEqual([4])
  })

  // A sign after <, >, / or % is refused as a second relative modifier
  // before the number is read, not reported as an invalid number.
  it.each(['<+4', '<\t+4'])("refuses '%s' as multiple relative modifiers", async (value) => {
    await expect(runTruncate(value)).rejects.toThrow(
      new UsageError(
        "truncate: multiple relative modifiers specified\nTry 'truncate --help' for more information.",
        1,
      ),
    )
  })

  // The digits must follow the sign immediately: no second sign, no gap,
  // and no trailing whitespace. GNU quotes the remainder past the skipped
  // whitespace and mode character, sign included, and escapes it.
  it.each([
    ['<abc', 'abc'],
    ['4\t', '4\\t'],
  ])("rejects '%s' as an invalid number without touching the file", async (value, quoted) => {
    const truncateCalls: number[] = []
    await expect(
      truncateGeneric(
        [fPath()],
        { size: value, noCreate: false },
        () =>
          Promise.resolve(
            new FileStat({ name: 'f', type: FileType.FILE, content: ContentType.TEXT, size: 10 }),
          ),
        (_p, length) => {
          truncateCalls.push(length)
          return Promise.resolve()
        },
      ),
    ).rejects.toThrow(new UsageError(`truncate: Invalid number: '${quoted}'`, 1))
    expect(truncateCalls).toEqual([])
  })

  it('bounds off_t asymmetrically', async () => {
    // off_t is signed: 2**63 is one too large upward but fine downward.
    expect(await runTruncate('8191P', 0)).toEqual([8191 * 1024 ** 5])
    expect(await runTruncate('-8E', 10)).toEqual([0])
    expect(await runTruncate('-9223372036854775808', 10)).toEqual([0])
    await expect(runTruncate('8E')).rejects.toThrow(
      new UsageError("truncate: Invalid number: '8E': Value too large for defined data type", 1),
    )
    await expect(runTruncate('9223372036854775808')).rejects.toThrow(
      new UsageError(
        "truncate: Invalid number: '9223372036854775808': Value too large for defined data type",
        1,
      ),
    )
  })

  it('rejects division by zero', async () => {
    await expect(runTruncate('/0')).rejects.toThrow(new UsageError('truncate: division by zero', 1))
  })
})

describe('truncate operands', () => {
  function operand(rawPath: string, virtual = '/missing'): PathSpec {
    return new PathSpec({ virtual, directory: '/', vfsPath: virtual.slice(1), rawPath })
  }

  it("answers a slashed operand with the open's EISDIR", async () => {
    // GNU opens with O_CREAT before it stats, so `missing/` and `reg/` are
    // the open's EISDIR, not the stat's miss, and an absent bare name is
    // made where its directory exists. The EISDIR is settled before the
    // op, so a backend with no truncate op says it too. The chain answers
    // first: under an absent directory the name is ENOENT and the op never
    // runs, every operand is still tried, and -c leaves an absent name
    // alone.
    const lengths: [string, number][] = []
    const stat = (path: PathSpec): Promise<FileStat> => Promise.reject(enoent(path))
    const truncate = (path: PathSpec, length: number): Promise<void> => {
      lengths.push([path.rawPath, length])
      return Promise.resolve()
    }
    const [, io] = await truncateGeneric(
      [operand('/missing/'), operand('/nodir/x', '/nodir/x'), operand('/missing')],
      { size: '4', noCreate: false },
      stat,
      truncate,
    )
    expect(lengths).toEqual([['/missing', 4]])
    expect(io.exitCode).toBe(1)
    expect(new TextDecoder().decode(io.stderr as Uint8Array)).toBe(
      "truncate: cannot open '/missing/' for writing: Is a directory\n" +
        "truncate: cannot open '/nodir/x' for writing: No such file or directory\n",
    )
    const [, kept] = await truncateGeneric(
      [operand('/missing')],
      { size: '4', noCreate: true },
      stat,
      truncate,
    )
    expect(kept.exitCode).toBe(0)
    expect(lengths).toHaveLength(1)
  })
})

it('passes no-create to the mutation after a successful stat', async () => {
  const calls: boolean[] = []
  const path = PathSpec.fromStrPath('/file')
  const [, result] = await truncateGeneric(
    [path],
    { size: '2', noCreate: true },
    () => Promise.resolve(new FileStat({ name: 'file', type: FileType.FILE, size: 4 })),
    (_path, _length, noCreate) => {
      calls.push(noCreate)
      return Promise.resolve()
    },
  )
  expect(result.exitCode).toBe(0)
  expect(calls).toEqual([true])
})
