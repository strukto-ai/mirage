import { concat } from '../../../io/cachable_iterator.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { gunzipStream } from '../../../utils/compress.ts'
import { fsErrorLine, GzipDataError, isFsError } from '../../../utils/errors.ts'
import { mountedPath } from '../../../utils/key_prefix.ts'
import { readFailExitCode } from '../../spec/usage.ts'
import { STDIN_OPERAND } from '../utils/constants.ts'
import { operandLabel, stdinStream } from '../utils/stream.ts'

interface DecompressOptions {
  command: string
  stdin: ByteSource | null
  toStdout?: boolean
  testOnly?: boolean
  keep?: boolean
  write?: (path: PathSpec, data: Uint8Array) => Promise<void>
  unlink?: (path: PathSpec) => Promise<void>
}

export async function decompressInputs(
  paths: PathSpec[],
  read: (path: PathSpec) => AsyncIterable<Uint8Array>,
  options: DecompressOptions,
): Promise<[ByteSource | null, IOResult]> {
  const operands = paths.length > 0 ? paths : [STDIN_OPERAND]
  const stream = stdinStream(read, options.stdin)
  const io = new IOResult()
  const enc = new TextEncoder()
  let errors = ''
  function report(message: string, code: number): void {
    errors += message
    io.stderr = enc.encode(errors)
    if (io.exitCode !== 1) io.exitCode = code
  }
  async function* run(): AsyncIterable<Uint8Array> {
    for (const path of operands) {
      const inPlace = !(
        options.toStdout === true ||
        options.testOnly === true ||
        path.rawPath === '-'
      )
      const chunks: Uint8Array[] = []
      try {
        for await (const chunk of gunzipStream(
          inPlace ? read(path) : stream(path),
          options.testOnly === true,
        )) {
          if (inPlace) chunks.push(chunk)
          else if (!options.testOnly) yield chunk
        }
      } catch (err) {
        if (err instanceof GzipDataError) {
          report(err.render(options.command, operandLabel(path, 'stdin')), err.exitCode)
          if (err.fatal) return
          if (!err.keepsOutput) continue
        } else {
          if (!isFsError(err)) throw err
          report(fsErrorLine(options.command, path, err), readFailExitCode(options.command, err))
          continue
        }
      }
      if (inPlace) {
        if (options.write === undefined || options.unlink === undefined)
          throw new Error('in-place decompression requires write and unlink')
        const stripped = path.mountPath
        const outPath = stripped.endsWith('.gz') ? stripped.slice(0, -3) : stripped + '.out'
        const data = concat(chunks)
        await options.write(mountedPath(path, outPath), data)
        io.writes[outPath] = data
        if (!options.keep) await options.unlink(path)
      }
    }
  }
  const body = run()
  if (options.testOnly || operands.some((p) => !(options.toStdout === true || p.rawPath === '-'))) {
    const output = await materialize(body)
    return [output.byteLength > 0 ? output : null, io]
  }
  return [body, io]
}
