import { eloop, enoent, isDotWalkError, isEisdir, isEnoent, isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { ByteSpool, spooled } from '../../../io/spool.ts'
import { closeQuietly } from '../../../io/stream.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { encodeText } from '../../../shell/bytes.ts'
import {
  FileType,
  PathSpec,
  type FileStat,
  type ReaddirFn,
  type SetAttrFields,
  type StatFn,
} from '../../../types.ts'
import {
  gunzipStream,
  GzipDataError,
  readGzipFacts,
  type GzipFacts,
} from '../../../utils/compress.ts'
import { systemNow } from '../../../utils/clock.ts'
import { epochToIso, isoTimestamp } from '../../../utils/dates.ts'
import { respelled } from '../../../utils/key_prefix.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { stripSlash } from '../../../utils/slash.ts'
import {
  GZIP_KNOWN_SUFFIXES,
  GZIP_LIST_HEAD,
  GZIP_LIST_VERBOSE_HEAD,
  GZIP_LIST_VERBOSE_INDENT,
  GZIP_MAX_SUFFIX,
  GZIP_RETRY_SUFFIXES,
  GZIP_SUFFIX,
  GZIP_TAR_SUFFIXES,
} from '../constants.ts'
import { MONTHS, STDIN_OPERAND } from '../utils/constants.ts'
import { pathExists } from '../utils/copy.ts'
import type { LinkResolver } from '../utils/links.ts'
import { descendantPath, isImplicitDir } from '../utils/paths.ts'
import { stdinStream } from '../utils/stream.ts'
import { beforeFullWalk } from '../utils/tree.ts'

export type SetAttrsFn = (path: PathSpec, fields: SetAttrFields) => Promise<unknown>

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/**
 * The compression suffix gzip reads off `name`, as spelled there.
 *
 * As gzip 1.13 reads it: the -S suffix and the ones gzip always knows,
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
  const here = `/${stripSlash(path.virtual)}`
  return [path.rawPath.slice(0, -cut) + tar, PathSpec.fromStrPath(here.slice(0, -cut) + tar)]
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
  const here = `/${stripSlash(path.virtual)}`
  if (typed === '') {
    const base = here.replace(/\/+$/, '') + '/'
    return suffixes.map((s) => respelled(PathSpec.fromStrPath(base + s), s))
  }
  const last = typed.slice(typed.lastIndexOf('/') + 1)
  if (last === '' || last === '.' || last === '..' || isDotWalkError(missing)) return []
  return suffixes.map((s) => respelled(PathSpec.fromStrPath(here + s), typed + s))
}

async function* resumed(
  first: IteratorResult<Uint8Array>,
  rest: AsyncIterator<Uint8Array>,
): AsyncIterable<Uint8Array> {
  try {
    if (first.done === true) return
    yield first.value
    for (;;) {
      const next = await rest.next()
      if (next.done === true) return
      yield next.value
    }
  } finally {
    await closeQuietly(rest)
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

/**
 * Open one operand the way gzip 1.13 opens it.
 *
 * A name typed with a trailing slash has to be a directory. Without -c, -t
 * or -f gzip opens with O_NOFOLLOW, so a link standing at the name, dangling
 * or not, is ELOOP, which -q never quiets; with them it is followed, a
 * retried name through the dispatcher, since what it leads to may live on any
 * mount. A directory is a warning. A missing name with no suffix gzip knows
 * is retried, when decompressing, with each suffix in turn and reported with
 * the -S one; any other failure ends the operand. Every failure is reported
 * in gzip's words and answers null. Mirrors Python's open_gzip_input.
 */
export async function openGzipInput(
  path: PathSpec,
  source: (p: PathSpec) => AsyncIterable<Uint8Array>,
  /** Takes a failure's line, exit code and whether it is a warning. */
  report: (line: string, code: number, warning: boolean) => void,
  options: {
    suffix?: string
    decompress?: boolean
    follow?: boolean
    resolver?: LinkResolver | null
  } = {},
): Promise<GzipInput | null> {
  const suffix = options.suffix ?? GZIP_SUFFIX
  const resolver = options.resolver ?? null
  const retry = options.decompress !== false && gzipSuffix(path.rawPath, suffix) === null
  const names = [path]
  for (const name of names) {
    const link = resolver !== null ? resolver.linkAt(name) : null
    if (link !== null && options.follow !== true) {
      report(fsErrorLine('gzip', name, eloop(name)), 1, false)
      return null
    }
    try {
      if (resolver !== null && name === path && resolver.vanished(name)) throw enoent(name.virtual)
      // The router followed the operand itself; a retried name it never saw
      // is followed through the dispatcher.
      const reads =
        resolver !== null && link !== null && name !== path ? resolver.read(link) : source(name)
      return { name, stream: await opened(reads), link }
    } catch (err) {
      if (isEisdir(err)) {
        report(`gzip: ${name.rawPath} is a directory -- ignored\n`, 2, true)
        return null
      }
      if (isEnoent(err)) {
        if (retry && name === path) for (const item of retries(path, err, suffix)) names.push(item)
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
 * is an lstat: through the dispatcher while the namespace holds links, the mount's
 * own stat otherwise. Mirrors Python's output_taken.
 */
export async function outputTaken(
  where: PathSpec,
  stat: StatFn | undefined,
  resolver: LinkResolver | null,
): Promise<boolean> {
  if (resolver !== null)
    return pathExists((p) => resolver.lstat(p), PathSpec.fromStrPath(where.virtual))
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
 * dispatcher, since the link may sit on any mount. Mirrors Python's replace_output.
 */
export async function replaceOutput(
  out: PathSpec,
  data: ByteSource,
  write: (path: PathSpec, data: ByteSource) => Promise<void>,
  resolver: LinkResolver | null,
  beside: boolean,
): Promise<void> {
  if (resolver !== null && resolver.links.statAt(out.virtual) !== null)
    await resolver.unlink(out.virtual)
  if (beside && resolver !== null) {
    await resolver.write(out.virtual, data)
    return
  }
  await write(out, data)
}

/**
 * Remove an input once its in-place output is written: the link it was named
 * through, when there is one. Mirrors Python's remove_input.
 */
export async function removeInput(
  path: PathSpec,
  link: string | null,
  unlink: (path: PathSpec) => Promise<void>,
  resolver: LinkResolver | null,
): Promise<void> {
  if (link === null || resolver === null) await unlink(path)
  else await resolver.unlink(link)
}

/** gzip's refusal to replace an output already standing at its name. */
export function existsLine(name: string): string {
  return `gzip: ${name} already exists;\tnot overwritten\n`
}

/** gzip's ratio column: how far below `size` the deflated bytes come, the
 * `header` bytes left out, none for empty data, written as printf's `%.1f`
 * writes it: the double's exact value rounded half to even, where `toFixed`
 * rounds a tie up. Mirrors Python's gzip_ratio. */
export function gzipRatio(size: number, compressed: number, header: number): string {
  const saved = size === 0 ? 0 : (100 * (size - (compressed - header))) / size
  const [whole = '0', fraction = ''] = Math.abs(saved).toFixed(60).split('.')
  const digit = Number(fraction[0] ?? '0')
  const rest = fraction.slice(1).replace(/0+$/, '')
  const up = rest > '5' || (rest === '5' && digit % 2 === 1)
  const text = (BigInt(whole) * 10n + BigInt(digit) + (up ? 1n : 0n)).toString().padStart(2, '0')
  const sign = saved < 0 ? '-' : ''
  return `${`${sign}${text.slice(0, -1)}.${text.slice(-1)}`.padStart(5)}%`
}

/** What -v says once an input is done, `output` its result's name or
 * `stdout`. Mirrors Python's verbose_line. */
export function verboseLine(shown: string, ratio: string, keep: boolean, output: string): string {
  return `${shown}:\t${ratio} -- ${keep ? 'created' : 'replaced with'} ${output}\n`
}

/** -l -v's date column, the month, day and minute in UTC. */
function listDate(epoch: number): string {
  const when = new Date(epoch * 1000)
  const hh = String(when.getUTCHours()).padStart(2, '0')
  const mm = String(when.getUTCMinutes()).padStart(2, '0')
  return `${MONTHS[when.getUTCMonth()] ?? ''} ${String(when.getUTCDate()).padStart(2)} ${hh}:${mm}`
}

/** The stat of what the input opened, for the attributes its output takes:
 * a link it followed gives what it leads to. Null when it cannot be had.
 * Mirrors Python's input_info. */
export async function inputInfo(
  stat: StatFn | undefined,
  path: PathSpec,
  link: string | null = null,
  resolver: LinkResolver | null = null,
): Promise<FileStat | null> {
  if (stat === undefined || path.rawPath === '-') return null
  try {
    if (link !== null && resolver !== null) return await resolver.stat(resolver.target(link))
    return await stat(path)
  } catch (err) {
    if (!isFsError(err)) throw err
    console.debug(`gzip: no stat for ${path.virtual}: ${String(err)}`)
    return null
  }
}

/** Give an in-place output its input's mode and times, as gzip does; a
 * nonzero `mtime` is the time -N restores from the header. Mirrors Python's
 * keep_attributes. */
export async function keepAttributes(
  setAttrs: SetAttrsFn | undefined,
  out: PathSpec,
  info: FileStat | null,
  mtime = 0,
): Promise<void> {
  if (setAttrs === undefined) return
  const fields: SetAttrFields = {}
  if (info !== null) {
    if (info.mode !== null) fields.mode = info.mode & 0o7777
    if (info.modified !== null && info.modified !== '') fields.mtime = info.modified
    if (info.atime !== null && info.atime !== '') fields.atime = info.atime
  }
  if (mtime !== 0) fields.mtime = epochToIso(mtime)
  if (Object.keys(fields).length === 0) return
  try {
    await setAttrs(out, fields)
  } catch (err) {
    if (!isFsError(err)) throw err
    console.debug(`gzip: attributes not kept on ${out.virtual}: ${String(err)}`)
  }
}

/** Whether -r walks into `path`: a directory, or a prefix a keyed backend
 * lists; a path that cannot be told is opened as a file, which reports why. */
async function isDirectory(stat: StatFn, readdir: ReaddirFn, path: PathSpec): Promise<boolean> {
  try {
    return (await stat(path)).type === FileType.DIRECTORY
  } catch (err) {
    if (!isFsError(err)) throw err
    if (!isEnoent(err)) {
      console.debug(`gzip: no stat for ${path.virtual}: ${String(err)}`)
      return false
    }
  }
  try {
    return await isImplicitDir(readdir, path)
  } catch (err) {
    if (!isFsError(err)) throw err
    console.debug(`gzip: no listing for ${path.virtual}: ${String(err)}`)
    return false
  }
}

/** Each operand in turn and, under -r, every file below a directory one,
 * siblings in name order; true marks a file the walk found. Mirrors
 * Python's walked. */
export async function* walked(
  paths: readonly PathSpec[],
  report: (line: string, code: number, warning: boolean) => void,
  options: { recursive?: boolean; stat?: StatFn | undefined; readdir?: ReaddirFn | undefined },
): AsyncGenerator<[PathSpec, boolean]> {
  async function* below(
    stat: StatFn,
    readdir: ReaddirFn,
    root: PathSpec,
    directory: PathSpec,
  ): AsyncGenerator<PathSpec> {
    let names: string[]
    try {
      names = [...(await readdir(directory))].sort(compareCodePoints)
    } catch (err) {
      if (!isFsError(err)) throw err
      report(fsErrorLine('gzip', directory, err), 1, false)
      return
    }
    for (const name of names) {
      const child = descendantPath(root, name.replace(/\/+$/, ''))
      if (await isDirectory(stat, readdir, child)) yield* below(stat, readdir, root, child)
      else yield child
    }
  }
  const { stat, readdir } = options
  for (const path of paths) {
    if (
      options.recursive !== true ||
      stat === undefined ||
      readdir === undefined ||
      path.rawPath === '-' ||
      !(await isDirectory(stat, readdir, path))
    ) {
      yield [path, false]
      continue
    }
    for await (const found of below(stat, readdir, path, path)) yield [found, true]
  }
}

/** Let the mount under each directory -r reads refuse the walk, before any
 * file is touched. Throws its refusal. Mirrors Python's ask_before_walks. */
export async function askBeforeWalks(
  paths: readonly PathSpec[],
  stat: StatFn | undefined,
  readdir: ReaddirFn | undefined,
  dispatch: DispatchFn | undefined,
): Promise<void> {
  if (stat === undefined || readdir === undefined) return
  for (const path of paths)
    if (path.rawPath !== '-' && (await isDirectory(stat, readdir, path)))
      await beforeFullWalk(dispatch, path, 'gzip')
}

/** The output -N names from the stored name: its last component, beside the
 * input; null when it stores no usable one. */
function named(path: PathSpec, stored: string | null): [string, PathSpec] | null {
  const base = (stored ?? '').split('/').at(-1) ?? ''
  if (base === '' || base === '.' || base === '..') return null
  const cut = path.rawPath.lastIndexOf('/')
  const typed = cut < 0 ? base : `${path.rawPath.slice(0, cut + 1)}${base}`
  const here = `/${stripSlash(path.virtual)}`
  return [typed, PathSpec.fromStrPath(`${here.slice(0, here.lastIndexOf('/') + 1)}${base}`)]
}

function decodedLine(shown: string, facts: GzipFacts, keep: boolean, out: string): string {
  return verboseLine(shown, gzipRatio(facts.size, facts.compressed, facts.header), keep, out)
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
 * turns out corrupt the reference has already unlinked it: mirage keeps it.
 *
 * Under -r a directory gives way to the files below it, and one found there
 * with no known suffix is passed over, said only under -v, unless its bytes
 * go to stdout. -v says each input's ratio once done (`OK` under -t), never
 * for stdin's. -N names an in-place output from the stored name and gives it
 * the stored time; any in-place output takes its input's mode and times.
 * Mirrors Python's decompress_inputs.
 */
export async function decompressInputs(
  paths: PathSpec[],
  read: (path: PathSpec) => AsyncIterable<Uint8Array>,
  options: {
    stdin: ByteSource | null
    toStdout?: boolean
    testOnly?: boolean
    keep?: boolean
    force?: boolean
    quiet?: boolean
    verbose?: boolean
    restore?: boolean
    recursive?: boolean
    suffix?: string
    write?: (path: PathSpec, data: ByteSource) => Promise<void>
    unlink?: (path: PathSpec) => Promise<void>
    stat?: StatFn
    readdir?: ReaddirFn
    setAttrs?: SetAttrsFn
    resolver?: LinkResolver | null
  },
): Promise<[ByteSource | null, IOResult]> {
  const suffix = options.suffix ?? GZIP_SUFFIX
  const verbose = options.verbose === true
  const keep = options.keep === true
  const refused = suffixRefusal(suffix)
  if (refused !== null) return [null, refused]
  const force = options.force === true
  const quiet = options.quiet === true
  const testOnly = options.testOnly === true
  const resolver = options.resolver ?? null
  const follow = options.toStdout === true || testOnly || force
  const operands = paths.length > 0 ? paths : [STDIN_OPERAND]
  const stream = stdinStream(read, options.stdin)
  const io = new IOResult()
  let errors = ''
  function note(line: string): void {
    errors += line
    io.stderr = encodeText(errors)
  }
  function report(line: string, code: number, warning = false): void {
    if (!(warning && quiet)) note(line)
    if (io.exitCode !== 1) io.exitCode = code
  }
  function fail(err: GzipDataError, shown: string, started = ''): void {
    report(started + err.render(shown), err.exitCode, err.exitCode === 2)
  }
  async function* run(): AsyncIterable<Uint8Array> {
    for await (const [operand, walk] of walked(operands, report, options)) {
      const onStdin = operand.rawPath === '-'
      const inPlace = !(options.toStdout === true || testOnly || onStdin)
      const found = onStdin
        ? null
        : await openGzipInput(operand, inPlace ? read : stream, report, {
            suffix,
            follow,
            resolver,
          })
      if (found === null && !onStdin) continue
      const path = found === null ? operand : found.name
      const source = found === null ? stream(operand) : found.stream
      const link = found === null ? null : found.link
      const shown = onStdin ? 'stdin' : path.rawPath
      const output = inPlace ? decompressed(path, suffix) : null
      const passed = walk && (inPlace || testOnly) && gzipSuffix(path.rawPath, suffix) === null
      if (passed || (inPlace && output === null)) {
        if (walk ? verbose : !quiet) report(`gzip: ${shown}: unknown suffix -- ignored\n`, 2)
        await closeQuietly(source)
        continue
      }
      const facts: GzipFacts[] = []
      const spool = new ByteSpool()
      try {
        let failure: GzipDataError | null = null
        try {
          for await (const chunk of gunzipStream(source, testOnly, force && !inPlace, (f) =>
            facts.push(f),
          )) {
            if (inPlace) await spool.append(chunk)
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
        const stored = facts[0] ?? null
        if (output === null) {
          if (failure !== null) {
            fail(failure, shown)
            if (failure.fatal || (onStdin && failure.firstHeader)) return
          } else if (verbose && testOnly) {
            note(onStdin ? ' OK\n' : `${shown}:\t OK\n`)
          } else if (verbose && stored !== null && !onStdin) {
            note(decodedLine(shown, stored, keep, 'stdout'))
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
        const [outName, outPath] =
          (options.restore === true && stored !== null ? named(path, stored.name) : null) ?? output
        const out = link === null ? outPath : besideLink(link, outName)
        const existed = await outputTaken(out, options.stat, resolver)
        if (existed && !force) {
          report(existsLine(outName), 2)
          continue
        }
        let started = ''
        if (failure !== null) {
          if (verbose && failure.keepsOutput && stored !== null) started = `${shown}:\t`
          fail(failure, shown, started)
          if (failure.fatal) return
          if (!failure.keepsOutput) continue
        }
        const data = spool.stream()
        try {
          await replaceOutput(out, data, options.write, resolver, link !== null)
        } catch (err) {
          if (!isFsError(err)) throw err
          const line = fsErrorLine('gzip', outName, err)
          report(existed ? line : '\n' + line, 1)
          if (existed) continue
          return
        }
        await keepAttributes(
          options.setAttrs,
          out,
          await inputInfo(options.stat, path, link, resolver),
          options.restore === true && stored !== null ? stored.mtime : 0,
        )
        if (verbose && stored !== null)
          note(decodedLine(shown, stored, keep, outName).slice(started.length))
        if (!keep) await removeInput(path, link, options.unlink, resolver)
      } finally {
        await spool.close()
        await closeQuietly(source)
      }
    }
  }
  const body = run()
  if (testOnly || operands.some((p) => !(options.toStdout === true || p.rawPath === '-'))) {
    return [await spooled(body), io]
  }
  return [body, io]
}

/**
 * `gzip -l`: one row per input that decodes, checked whole.
 *
 * An input opens as for `-c` and one that fails to decode is reported in
 * gzip's words and passed over. The head comes before the first row, and
 * with more than one operand a totals row ends the table once any row was
 * printed, its ratio leaving out the header bytes of the input tried last
 * (none for one that failed), as the reference counts it; -q drops both. The
 * name is the input's without its suffix, or the stored one under -N; -v adds
 * the method, the CRC and the date: the file's own, or the stored one under
 * -N. Mirrors Python's list_inputs.
 */
export async function listInputs(
  paths: PathSpec[],
  read: (path: PathSpec) => AsyncIterable<Uint8Array>,
  options: {
    stdin: ByteSource | null
    quiet?: boolean
    verbose?: boolean
    restore?: boolean
    recursive?: boolean
    suffix?: string
    stat?: StatFn
    readdir?: ReaddirFn
    resolver?: LinkResolver | null
  },
): Promise<[ByteSource | null, IOResult]> {
  const suffix = options.suffix ?? GZIP_SUFFIX
  const refused = suffixRefusal(suffix)
  if (refused !== null) return [null, refused]
  const quiet = options.quiet === true
  const verbose = options.verbose === true
  const restore = options.restore === true
  const operands = paths.length > 0 ? paths : [STDIN_OPERAND]
  const stream = stdinStream(read, options.stdin)
  const io = new IOResult()
  let errors = ''
  const rows: string[] = []
  let compressedTotal = 0
  let sizeTotal = 0
  let header = 0
  function report(line: string, code: number, warning = false): void {
    if (!(warning && quiet)) {
      errors += line
      io.stderr = encodeText(errors)
    }
    if (io.exitCode !== 1) io.exitCode = code
  }
  for await (const [operand, walk] of walked(operands, report, options)) {
    const onStdin = operand.rawPath === '-'
    const opened = onStdin
      ? null
      : await openGzipInput(operand, stream, report, {
          suffix,
          follow: true,
          resolver: options.resolver ?? null,
        })
    if (opened === null && !onStdin) continue
    const path = opened === null ? operand : opened.name
    const source = opened === null ? stream(operand) : opened.stream
    const shown = onStdin ? 'stdin' : path.rawPath
    if (walk && gzipSuffix(path.rawPath, suffix) === null) {
      await closeQuietly(source)
      if (verbose) report(`gzip: ${shown}: unknown suffix -- ignored\n`, 2)
      continue
    }
    let facts: GzipFacts
    try {
      facts = await readGzipFacts(source)
    } catch (err) {
      header = 0
      if (err instanceof GzipDataError) {
        report(err.render(shown), err.exitCode, err.exitCode === 2)
        continue
      }
      if (!isFsError(err)) throw err
      report('\n' + fsErrorLine('gzip', shown, err), 1)
      continue
    }
    header = facts.header
    compressedTotal += facts.compressed
    sizeTotal += facts.size
    const stripped = decompressed(path, suffix)
    let name = onStdin ? 'stdout' : stripped === null ? path.rawPath : stripped[0]
    if (restore && facts.name !== null && facts.name !== '') name = facts.name
    let numbers = `${String(facts.compressed).padStart(19)} ${String(facts.size).padStart(19)} ${gzipRatio(facts.size, facts.compressed, facts.header)}`
    if (rows.length === 0 && !quiet) rows.push(verbose ? GZIP_LIST_VERBOSE_HEAD : GZIP_LIST_HEAD)
    if (verbose) {
      let when: number
      if (restore && facts.mtime !== 0) when = facts.mtime
      else {
        const info = await inputInfo(options.stat, path)
        when = (info === null ? null : isoTimestamp(info.modified)) ?? systemNow()
      }
      numbers = `defla ${facts.crc.toString(16).padStart(8, '0')} ${listDate(when)} ${numbers}`
    }
    rows.push(`${numbers} ${name}`)
  }
  if (rows.length > 0 && operands.length > 1 && !quiet) {
    const indent = verbose ? ' '.repeat(GZIP_LIST_VERBOSE_INDENT) : ''
    rows.push(
      `${indent}${String(compressedTotal).padStart(19)} ${String(sizeTotal).padStart(19)} ${gzipRatio(sizeTotal, compressedTotal, header)} (totals)`,
    )
  }
  return [encodeText(rows.map((row) => `${row}\n`).join('')), io]
}
