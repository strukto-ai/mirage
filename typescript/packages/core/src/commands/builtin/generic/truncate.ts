import { IOResult } from '../../../io/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import type { CommandFnResult } from '../../config.ts'

const UNITS: Readonly<Record<string, number>> = {
  K: 1024,
  KB: 1000,
  M: 1024 ** 2,
  MB: 1000 ** 2,
  G: 1024 ** 3,
  GB: 1000 ** 3,
  T: 1024 ** 4,
  TB: 1000 ** 4,
}

function parseSize(value: string, current: number): number {
  const first = value.slice(0, 1)
  const operation = ['+', '-', '<', '>', '/', '%'].includes(first) ? first : ''
  const raw = operation === '' ? value : value.slice(1)
  const suffix = Object.keys(UNITS)
    .sort((a, b) => b.length - a.length)
    .find((unit) => raw.endsWith(unit))
  const numeric = suffix === undefined ? raw : raw.slice(0, -suffix.length)
  const number = Number.parseInt(numeric, 10) * (suffix === undefined ? 1 : (UNITS[suffix] ?? 1))
  if (operation === '+') return current + number
  if (operation === '-') return Math.max(0, current - number)
  if (operation === '<') return Math.min(current, number)
  if (operation === '>') return Math.max(current, number)
  if (operation === '/') return current - (current % number)
  if (operation === '%') return Math.ceil(current / number) * number
  return number
}

export async function truncateGeneric(
  paths: readonly PathSpec[],
  size: string,
  stat: (path: PathSpec) => Promise<FileStat>,
  truncate: (path: PathSpec, length: number) => Promise<void>,
): Promise<CommandFnResult> {
  if (paths.length === 0) throw new Error('truncate: missing file operand')
  for (const path of paths) {
    const current = (await stat(path)).size ?? 0
    await truncate(path, parseSize(size, current))
  }
  return [null, new IOResult()]
}
