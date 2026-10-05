import { concat } from '../../../io/cachable_iterator.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { gunzipStream } from '../../../utils/compress.ts'
import {
  enoent,
  eloop,
  fsErrorLine,
  GzipDataError,
  isDotWalkError,
  isEisdir,
  isEnoent,
  isFsError,
} from '../../../utils/errors.ts'
import { mountedPath, respelled } from '../../../utils/key_prefix.ts'
import type { LinkDoor } from '../utils/links.ts'
import {
  GZIP_KNOWN_SUFFIXES,
  GZIP_MAX_SUFFIX,
  GZIP_RETRY_SUFFIXES,
  GZIP_SUFFIX,
  GZIP_TAR_SUFFIXES,
} from '../constants.ts'
import type { StatFn } from './archive/walk.ts'
import { pathExists } from '../utils/copy.ts'
import { STDIN_OPERAND } from '../utils/constants.ts'
import { stdinStream } from '../utils/stream.ts'
import { encodeText } from '../../../shell/bytes.ts'

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/**
 * The compression suffix gzip reads off `name`, as spelled there.
 *
 * gzip 1.13's get_suffix: the -S suffix and the ones gzip always knows,
 * compared without regard to ASCII case, and only where the name is longer
 * than the suffix with no slash right before it, so neither `.gz` nor
 * `d/.gz` has one. A -S suffix that ends one of the built-in ones is tried
 * after them, or `-S z` would take the `z` off `a.gz`. Mirrors Python's
 * gzip_suffix.
 */
export function gzipSuffix(name: string, suffix: string): string | null {
  const inner = GZIP_KNOWN_SUFFIXES.some((k) => suffix.length < k.length && k.endsWith(suffix))
  const own = asciiLower(suffix)
  const order = inner ? [...GZIP_KNOWN_SUFFIXES, own] : [own, ...GZIP_KNOWN_SUFFIXES]
  const lowered = asciiLower(name)
  for (const known of order) {
    const cut = lowered.length - known.length
    if (cut > 0 && lowered.endsWith(known) && lowered[cut - 1] !== '/') return name.slice(cut)
  }
  return null
}

/** gzip's refusal of a -S suffix it cannot use, before any input. Mirrors
 * Python's suffix_refusal. */
export function suffixRefusal(suffix: string): IOResult | null {
  const bytes = encodeText(suffix).byteLength
  if (bytes > 0 && bytes <= GZIP_MAX_SUFFIX) return null
  return new IOResult({ exitCode: 1, stderr: encodeText(`gzip: invalid suffix '${suffix}'\n`) })
}

/**
 * The output `gzip -d` names for `path`, typed and mounted; null for a name
 * with no suffix gzip knows. `.tgz` and `.taz`, in any case, become `.tar`;
 * any other suffix is dropped.
 */
function decompressed(path: PathSpec, suffix: string): [string, PathSpec] | null {
  const found = gzipSuffix(path.rawPath, suffix)
  if (found === null) return null
  const tar = (GZIP_TAR_SUFFIXES as readonly string[]).includes(asciiLower(found)) ? '.tar' : ''
  const cut = found.length
  return [path.rawPath.slice(0, -cut) + tar, mountedPath(path, path.mountPath.slice(0, -cut) + tar)]
}

/**
 * The names gzip -d opens in turn when `path` does not exist.
 *
 * Each is the name as typed with one suffix appended, in the same directory;
 * the empty name makes the suffix itself the name. A name ending in a slash
 * or a dot, or one whose walk failed before its last component, has no
 * directory to hold a suffixed twin, so every one of them misses too. A
 * retried name is read on the operand's own mount, where a namespace link is
 * not followed.
 */
function retries(path: PathSpec, missing: unknown, suffix: string): PathSpec[] {
  const suffixes = suffix === GZIP_SUFFIX ? GZIP_RETRY_SUFFIXES : [suffix, ...GZIP_RETRY_SUFFIXES]
  const typed = path.rawPath
  if (typed === '') {
    const base = path.mountPath.replace(/\/+$/, '') + '/'
    return suffixes.map((s) => respelled(mountedPath(path, base + s), s))
  }
  const last = typed.slice(typed.lastIndexOf('/') + 1)
  if (last === '' || last === '.' || last === '..' || isDotWalkError(missing)) return []
  return suffixes.map((s) => respelled(mountedPath(path, path.mountPath + s), typed + s))
}

async function* resumed(
  first: IteratorResult<Uint8Array>,
  rest: AsyncIterator<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (first.done === true) return
  yield first.value
  for (;;) {
    const next = await rest.next()
    if (next.done === true) return
    yield next.value
  }
}

/** `source` read up to its first chunk, so a failed open throws here. */
async function opened(source: AsyncIterable<Uint8Array>): Promise<AsyncIterable<Uint8Array>> {
  const iterator = source[Symbol.asyncIterator]()
  return resumed(await iterator.next(), iterator)
}

/**
 * One input gzip opened, and the name it opened it by: the operand or a
 * suffixed retry of it, as typed, and its bytes, read up to the first chunk.
 * `link` is where the link the name stands on sits, when gzip followed one:
 * an output in place is made beside the link, and the input it then removes
 * is the link itself. Mirrors Python's GzipInput.
 */
export interface GzipInput {
  name: PathSpec
  stream: AsyncIterable<Uint8Array>
  link: string | null
}

/** Takes a failure's line, exit code and whether it is a warning. */
export type GzipReport = (line: string, code: number, warning: boolean) => void

interface GzipOpenOptions {
  suffix?: string
  decompress?: boolean
  follow?: boolean
  door?: LinkDoor | null
}

/**
 * Open one operand the way gzip 1.13's open_input_file does.
 *
 * A name typed with a trailing slash has to be a directory. Without -c, -t
 * or -f gzip opens with O_NOFOLLOW, so a link standing at the name, dangling
 * or not, is ELOOP, which -q never quiets; with them it is followed, a
 * retried name through the door, since what it leads to may live on any
 * mount. A directory is a warning. A missing name with no suffix gzip knows
 * is retried, when decompressing, with each suffix in turn and reported with
 * the -S one; any other failure ends the operand. Every failure is reported
 * in gzip's words and answers null. Mirrors Python's open_gzip_input.
 */
export async function openGzipInput(
  path: PathSpec,
  source: (p: PathSpec) => AsyncIterable<Uint8Array>,
  report: GzipReport,
  options: GzipOpenOptions = {},
): Promise<GzipInput | null> {
  const suffix = options.suffix ?? GZIP_SUFFIX
  const door = options.door ?? null
  const retry = options.decompress !== false && gzipSuffix(path.rawPath, suffix) === null
  const names = [path]
  for (const name of names) {
    const link = door !== null ? door.linkAt(name) : null
    if (link !== null && options.follow !== true) {
      report(fsErrorLine('gzip', name, eloop(name)), 1, false)
      return null
    }
    try {
      if (door !== null && name === path && door.vanished(name)) throw enoent(name.virtual)
      // The router followed the operand itself; a retried name it never saw
      // is followed through the door.
      const reads = door !== null && link !== null && name !== path ? door.read(link) : source(name)
      return { name, stream: await opened(reads), link }
    } catch (err) {
      if (isEisdir(err)) {
        report(`gzip: ${name.rawPath} is a directory -- ignored\n`, 2, true)
        return null
      }
      if (isEnoent(err)) {
        if (retry && name === path) names.push(...retries(path, err, suffix))
        continue
      }
      if (!isFsError(err)) throw err
      report(fsErrorLine('gzip', name, err), 1, false)
      return null
    }
  }
  const missing = retry ? path.rawPath + suffix : path.rawPath
  report(fsErrorLine('gzip', missing, enoent(missing)), 1, false)
  return null
}

/**
 * Whether anything stands where gzip creates an output. gzip creates with
 * O_EXCL, which a link standing there refuses, dangling or not, so the probe
 * is an lstat: through the door while the namespace holds links, the mount's
 * own stat otherwise. Mirrors Python's output_taken.
 */
export async function outputTaken(
  where: PathSpec,
  stat: StatFn | undefined,
  door: LinkDoor | null,
): Promise<boolean> {
  if (door !== null) return pathExists((p) => door.lstat(p), PathSpec.fromStrPath(where.virtual))
  return stat !== undefined && (await pathExists(stat, where))
}

/** An output gzip names from a typed name standing on a link: in the link's
 * own directory, whatever the link leads to. Mirrors Python's beside_link. */
export function besideLink(link: string, typed: string): PathSpec {
  const dir = link.slice(0, link.lastIndexOf('/'))
  return PathSpec.fromStrPath(`${dir}/${typed.slice(typed.lastIndexOf('/') + 1)}`)
}

/**
 * Write an in-place output, replacing a link standing at its name. gzip -f
 * unlinks whatever holds the name before it creates the file, so a link there
 * is removed, never written through; an output beside a link goes through the
 * door, since the link may sit on any mount. Mirrors Python's replace_output.
 */
export async function replaceOutput(
  out: PathSpec,
  data: Uint8Array,
  write: (path: PathSpec, data: Uint8Array) => Promise<void>,
  door: LinkDoor | null,
  beside: boolean,
): Promise<void> {
  if (door !== null && door.links.statAt(out.virtual) !== null) await door.unlink(out.virtual)
  if (beside && door !== null) {
    await door.write(out.virtual, data)
    return
  }
  await write(out, data)
}

interface DecompressOptions {
  stdin: ByteSource | null
  toStdout?: boolean
  testOnly?: boolean
  keep?: boolean
  force?: boolean
  quiet?: boolean
  suffix?: string
  write?: (path: PathSpec, data: Uint8Array) => Promise<void>
  unlink?: (path: PathSpec) => Promise<void>
  stat?: StatFn
  door?: LinkDoor | null
}

/**
 * Decode operands in order the way gzip 1.13 does, in its voice.
 *
 * gunzip and zcat are gzip, so every line says `gzip:`. Each operand opens as
 * `openGzipInput` says. In place, a name with no known suffix and an output
 * already there are skipped with a warning (exit 2), a link standing there
 * counting as one; a warning under -q prints nothing and keeps its exit code,
 * except the unknown suffix, which -q drops whole. -f replaces an output, and
 * decodes a name standing on a link beside the link, removing the link rather
 * than what it leads to; with the output stdout it copies what is not gzip.
 * An input stdin cannot open as gzip ends the run, as gzip exits there.
 *
 * With -f, an output already there is replaced, and when the input then
 * turns out corrupt GNU has already unlinked it: mirage keeps it. Mirrors
 * Python's decompress_inputs.
 */
export async function decompressInputs(
  paths: PathSpec[],
  read: (path: PathSpec) => AsyncIterable<Uint8Array>,
  options: DecompressOptions,
): Promise<[ByteSource | null, IOResult]> {
  const suffix = options.suffix ?? GZIP_SUFFIX
  const refused = suffixRefusal(suffix)
  if (refused !== null) return [null, refused]
  const force = options.force === true
  const quiet = options.quiet === true
  const testOnly = options.testOnly === true
  const door = options.door ?? null
  const follow = options.toStdout === true || testOnly || force
  const operands = paths.length > 0 ? paths : [STDIN_OPERAND]
  const stream = stdinStream(read, options.stdin)
  const io = new IOResult()
  let errors = ''
  function report(line: string, code: number, warning = false): void {
    if (!(warning && quiet)) {
      errors += line
      io.stderr = encodeText(errors)
    }
    if (io.exitCode !== 1) io.exitCode = code
  }
  function fail(err: GzipDataError, shown: string): void {
    report(err.render(shown), err.exitCode, err.exitCode === 2)
  }
  async function* run(): AsyncIterable<Uint8Array> {
    for (const operand of operands) {
      const onStdin = operand.rawPath === '-'
      const inPlace = !(options.toStdout === true || testOnly || onStdin)
      const found = onStdin
        ? null
        : await openGzipInput(operand, inPlace ? read : stream, report, {
            suffix,
            follow,
            door,
          })
      if (found === null && !onStdin) continue
      const path = found === null ? operand : found.name
      const source = found === null ? stream(operand) : found.stream
      const link = found === null ? null : found.link
      const shown = onStdin ? 'stdin' : path.rawPath
      const output = inPlace ? decompressed(path, suffix) : null
      if (inPlace && output === null) {
        if (!quiet) report(`gzip: ${shown}: unknown suffix -- ignored\n`, 2)
        continue
      }
      const chunks: Uint8Array[] = []
      let failure: GzipDataError | null = null
      try {
        for await (const chunk of gunzipStream(source, testOnly, force && !inPlace)) {
          if (inPlace) chunks.push(chunk)
          else if (!testOnly) yield chunk
        }
      } catch (err) {
        if (err instanceof GzipDataError) failure = err
        else {
          if (!isFsError(err)) throw err
          report('\n' + fsErrorLine('gzip', shown, err), 1)
          return
        }
      }
      if (output === null) {
        if (failure !== null) {
          fail(failure, shown)
          if (failure.fatal || (onStdin && failure.firstHeader)) return
        }
        continue
      }
      if (failure?.firstHeader === true) {
        fail(failure, shown)
        if (failure.fatal) return
        continue
      }
      if (options.write === undefined || options.unlink === undefined)
        throw new Error('in-place decompression requires write and unlink')
      const outName = output[0]
      const out = link === null ? output[1] : besideLink(link, outName)
      const existed = await outputTaken(out, options.stat, door)
      if (existed && !force) {
        report(`gzip: ${outName} already exists;\tnot overwritten\n`, 2)
        continue
      }
      if (failure !== null) {
        fail(failure, shown)
        if (failure.fatal) return
        if (!failure.keepsOutput) continue
      }
      const data = concat(chunks)
      try {
        await replaceOutput(out, data, options.write, door, link !== null)
      } catch (err) {
        if (!isFsError(err)) throw err
        const line = fsErrorLine('gzip', outName, err)
        report(existed ? line : '\n' + line, 1)
        if (existed) continue
        return
      }
      if (link === null) io.writes[out.mountPath] = data
      if (options.keep !== true) {
        if (link === null || door === null) await options.unlink(path)
        else await door.unlink(link)
      }
    }
  }
  const body = run()
  if (testOnly || operands.some((p) => !(options.toStdout === true || p.rawPath === '-'))) {
    const output = await materialize(body)
    return [output.byteLength > 0 ? output : null, io]
  }
  return [body, io]
}
