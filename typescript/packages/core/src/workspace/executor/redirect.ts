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

import type { EvaluationContext } from '../evaluation.ts'
import { runWithRedirectPaths } from '../../context/session_context.ts'
import { fsStrerror, isFsError, isMissingPath } from '../../errors/fs.ts'
import { stripSlash } from '../../utils/slash.ts'
import { SharedInput, share } from '../../io/async_line_iterator.ts'
import type { ByteSource } from '../../io/types.ts'
import { DeviceInput, IOResult, materialize } from '../../io/types.ts'
import { encodeText } from '../../shell/bytes.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import {
  FD_BOTH,
  FD_CLOSE,
  FD_STDERR,
  FD_STDIN,
  FD_STDOUT,
  OUTPUT_ONLY_BUILTINS,
} from '../../shell/constants.ts'
import {
  ENCLOSING,
  FileDescription,
  FileInput,
  Inherited,
  Recorder,
  type Descriptor,
  type StreamOwner,
  badDescriptorLine,
  deliver,
  unreadableStdin,
  unsupportedDescriptor,
} from '../../shell/descriptors.ts'
import { getText } from '../../shell/helpers.ts'
import { ExitSignal } from '../../shell/errors.ts'
import { NodeType as NT, type Redirect, RedirectKind } from '../../shell/types.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { SessionState } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { createFile, writeDescription } from './create.ts'
import {
  CLOSED as EXEC_CLOSED,
  EXEC_STREAM_UNBOUND,
  OPEN_FOR_READ_WRITE,
  OPEN_FOR_READING,
  TO_STDERR as EXEC_TO_STDERR,
  TO_STDIN as EXEC_TO_STDIN,
  TO_STDOUT as EXEC_TO_STDOUT,
} from './builtins/exec/constants.ts'
import { drained, pump } from './jobs.ts'
import type { ExecuteNodeFn } from './command/types.ts'
import { carried, isUnwinding, takeStderr, takeStdout, type Unwinding } from './control.ts'
import type { JobConsole } from '../../shell/console/index.ts'
import { Channel, JobOutput, type OwnedStream } from '../../shell/console/index.ts'
import { concat } from '../../io/cachable_iterator.ts'
import { posixPhrase } from '../../errors/posix.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

const TO_STDOUT = Symbol('stdout')
const TO_STDERR = Symbol('stderr')
// Where `>&-` points a descriptor: bytes written there are dropped, and a
// command whose stdout was closed reports the write failure the way GNU
// echo does.
const CLOSED = Symbol('closed')
type FdDest = typeof TO_STDOUT | typeof TO_STDERR | typeof CLOSED | FileDescription | Inherited

/**
 * Where a background job started under a redirect writes.
 *
 * Into the redirected command's recorder while the command runs, so it
 * goes through the descriptors with what the command writes; after that
 * straight through them, to the file the redirect opened or the stream it
 * pointed at, as bash's job keeps the descriptors it was started with.
 */
export class JobRoute extends JobOutput {
  /** Who the level's own stdout and stderr belong to, for a copy of them (`3>&1`). */
  readonly owner: StreamOwner

  constructor(
    recorder: Recorder,
    readonly outputs: ReadonlyMap<number, FdDest>,
    outer: JobConsole,
    readonly dispatch: DispatchFn,
    readonly session: SessionState,
  ) {
    super(outer)
    this.recorder = recorder
    this.owner = recorder.owner
  }

  /** Route what a job wrote. */
  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    if (this.recorder !== null) await this.recorder.emit(channel, data)
    else await this.write(channel, data)
  }

  /** Route what a job wrote to a stream a level owns. */
  override async emitTo(stream: OwnedStream, data: Uint8Array): Promise<void> {
    if (this.recorder !== null) await this.recorder.emitTo(stream, data)
    else await this.write(stream instanceof Inherited ? stream : stream.channel, data)
  }

  /** Which of the level's own writes, or the streams above it, a job's streams reach. */
  override passes(streams: ReadonlySet<Channel | OwnedStream>): Set<Channel | OwnedStream> {
    const reached = new Set<Channel | OwnedStream>()
    for (const stream of streams) {
      const dest =
        stream instanceof Inherited
          ? stream
          : typeof stream === 'string'
            ? this.outputs.get(stream === Channel.STDOUT ? 1 : 2)
            : undefined
      if (dest === TO_STDOUT) reached.add(Channel.STDOUT)
      else if (dest === TO_STDERR) reached.add(Channel.STDERR)
      else if (dest instanceof Inherited)
        reached.add(dest.owner === this.owner ? dest.channel : dest)
    }
    return reached
  }

  /**
   * Send on, in order, what jobs wrote while the redirect wrote its
   * command's output, then let them write straight through: the command
   * wrote first, and its first write is the one that opens the file. A
   * held write that fails is the job's, which has moved on, so it never
   * stops the line that released it: Python logs it at debug, and core,
   * which runs on every host, has no logger to give it to (`console`
   * writes to a Node process's stdout).
   */
  async release(): Promise<void> {
    try {
      let held = this.recorder
      while (held instanceof Recorder && held.chunks.length > 0) {
        this.recorder = new Recorder()
        for (const [key, data] of held.chunks) {
          try {
            await this.write(key, data)
          } catch (error) {
            if (!isFsError(error)) throw error
          }
        }
        held = this.recorder
      }
    } finally {
      this.recorder = null
    }
  }

  private async write(key: Channel | Inherited, data: Uint8Array): Promise<void> {
    if (key instanceof Inherited) {
      if (key.owner === this.owner) await this.target.emit(key.channel, data)
      else await this.target.emitTo(key, data)
      return
    }
    const dest = this.outputs.get(key === Channel.STDOUT ? 1 : 2)
    if (dest === TO_STDOUT) await this.target.emit(Channel.STDOUT, data)
    else if (dest === TO_STDERR) await this.target.emit(Channel.STDERR, data)
    else if (dest instanceof Inherited) await this.target.emitTo(dest, data)
    else if (dest instanceof FileDescription)
      await writeDescription(this.dispatch, this.session, dest, data)
  }
}

/** Ordered descriptor bindings for one command, restored after execution.
 * A target opened for writing is emptied before the command runs, as bash's
 * open-before-exec does, so `cat f > f` reads an empty file and `ls > out`
 * lists `out`; a target that cannot be opened stops the command before it
 * runs. A `>>` target is opened then too, created when it is missing, so
 * `ls >> out` lists `out`. A simple command opens its targets only once
 * dispatch admits it, so a command the gate refuses leaves them as they were.
 * A builtin that touches no file of its own (`echo`, `printf`, `:`) cannot
 * tell, so its targets are opened by the write of its output, one write per
 * target, and one that cannot be opened fails that write with the open's
 * error, the output dropped. Two opens stay out of bash's order: an input that cannot be opened stops the
 * line before any target is opened, where bash has emptied the ones written
 * before it, because the gate has not judged the line yet; and an input that
 * reaches a `>` target only through a symlink is read before the target is
 * emptied, since the paths are compared as typed. */
const UNREADABLE: unique symbol = Symbol('unreadable')
type Input = ByteSource | null | typeof UNREADABLE

export async function handleRedirect(
  executeNode: ExecuteNodeFn,
  dispatch: DispatchFn,
  command: TSNodeLike | null,
  redirects: readonly Redirect[],
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  captureInput = false,
  sink?: JobConsole,
): Promise<Result> {
  const session = context.session
  const badFd = unsupportedDescriptor(redirects)
  if (badFd !== null) return shellFailure(badDescriptorLine(badFd))
  const inputs = new Map<number, Input>([
    [0, share(stdin)],
    [1, UNREADABLE],
    [2, UNREADABLE],
  ])
  const outputs = new Map<number, FdDest>([
    [0, CLOSED],
    [1, TO_STDOUT],
    [2, TO_STDERR],
  ])
  const inputDest = stdinDest(context)
  if (typeof inputDest === 'string') {
    const file = new FileDescription(ensureScope(inputDest), true)
    file.opened = true
    outputs.set(0, file)
  } else outputs.set(0, inputDest)
  const boundInput = session.descriptors.get(0)?.file
  if (boundInput != null) outputs.set(0, boundInput)
  if (stdin instanceof FileInput) outputs.set(0, stdin.description)
  if (session.execStdin instanceof FileInput) outputs.set(0, session.execStdin.description)
  for (const [fd, binding, source] of [
    [1, session.execStdout, session.execStdoutInput],
    [2, session.execStderr, session.execStderrInput],
  ] as const) {
    if (binding?.startsWith(OPEN_FOR_READING)) inputs.set(fd, source)
    else if (binding === EXEC_TO_STDIN) inputs.set(fd, inputs.get(0) ?? null)
  }
  const closed = persistentlyClosed(context)
  for (const [fd, descriptor] of session.descriptors) {
    if (fd <= 2) continue
    inputs.set(fd, descriptor.source ?? UNREADABLE)
    outputs.set(fd, descriptorOutput(descriptor))
    if (descriptor.identity === EXEC_CLOSED) closed.add(fd)
  }
  const files: FileDescription[] = []
  // bash empties a write target as it opens it, so the command finds nothing
  // to read in the same file through an input redirect.
  const truncated = new Map<string, number>()
  for (const [at, r] of redirects.entries()) {
    if (
      (r.kind === RedirectKind.STDOUT || r.kind === RedirectKind.STDERR) &&
      !r.append &&
      typeof r.target !== 'number'
    ) {
      const virtual = ensureScope(r.target).virtual
      if (!truncated.has(virtual)) truncated.set(virtual, at)
    }
  }
  for (const [at, r] of redirects.entries()) {
    if (r.kind === RedirectKind.AMBIGUOUS) {
      const word = r.target instanceof PathSpec ? r.target.rawPath : String(r.target)
      return shellFailure(encodeText(`${word}: ambiguous redirect\n`))
    }
    if (r.kind === RedirectKind.UNEXPANDED && r.target instanceof ExitSignal) {
      return shellFailure(r.target.stderr, r.target.exitCode)
    }
    if (typeof r.target === 'number') {
      if (r.target === FD_CLOSE) {
        closed.add(r.fd)
        inputs.set(r.fd, UNREADABLE)
        outputs.set(r.fd, CLOSED)
      } else if (r.target !== r.fd) {
        if (closed.has(r.target) || !outputs.has(r.target))
          return shellFailure(badDescriptorLine(r.target))
        let source = inputs.get(r.target) ?? null
        if (source !== UNREADABLE) {
          source = share(source ?? new Uint8Array())
          inputs.set(r.target, source)
        }
        inputs.set(r.fd, source)
        outputs.set(r.fd, outputs.get(r.target) ?? CLOSED)
        closed.delete(r.fd)
      }
      continue
    }
    const fds = r.fd === FD_BOTH ? [1, 2] : [r.fd]
    for (const fd of fds) {
      closed.delete(fd)
      inputs.set(fd, UNREADABLE)
      outputs.set(fd, CLOSED)
    }
    if (r.kind === RedirectKind.HEREDOC || r.kind === RedirectKind.HERESTRING) {
      const data = r.target
      if (typeof data === 'string') {
        let text = data
        if (r.kind === RedirectKind.HERESTRING) {
          if (text.length >= 2 && text.at(0) === text.at(-1) && ['"', "'"].includes(text.charAt(0)))
            text = text.slice(1, -1)
          text += '\n'
        }
        inputs.set(r.fd, r.fd === 0 ? encodeText(text) : new SharedInput(encodeText(text)))
      } else inputs.set(r.fd, data as ByteSource)
      continue
    }
    const scope = ensureScope(r.target)
    if (r.kind === RedirectKind.STDIN || r.kind === RedirectKind.READWRITE) {
      // Opened after the target was emptied there is nothing to read; opened
      // before, the file must still be there.
      const emptiedAt = r.kind === RedirectKind.STDIN ? truncated.get(scope.virtual) : undefined
      let source: ByteSource | null
      try {
        if (scope.virtual === '/dev/stdin' && r.kind === RedirectKind.STDIN) {
          inputs.set(r.fd, stdin)
          continue
        }
        source =
          emptiedAt !== undefined && emptiedAt < at
            ? new Uint8Array()
            : ((await dispatch('read', scope))[0] as ByteSource | null)
      } catch (error) {
        if (r.kind === RedirectKind.READWRITE && isMissingPath(error)) source = new Uint8Array()
        else {
          if (!isFsError(error)) throw error
          return redirectFailure(scope, error)
        }
      }
      const data = emptiedAt !== undefined ? new Uint8Array() : await materialize(source)
      if (r.kind === RedirectKind.READWRITE) {
        const file = new FileDescription(scope, true)
        file.source = new FileInput(file, data)
        files.push(file)
        inputs.set(r.fd, file.source)
        outputs.set(r.fd, file)
      } else
        inputs.set(
          r.fd,
          data.byteLength === 0 && (await isDevice(dispatch, scope))
            ? new DeviceInput()
            : r.fd === 0
              ? data
              : new SharedInput(data),
        )
    } else {
      const file = new FileDescription(scope, r.append)
      files.push(file)
      for (const fd of fds) outputs.set(fd, file)
    }
  }
  const refusal = await openRefusal(dispatch, context, redirects)
  if (refusal !== null) return refusal
  const opening = files.filter((file) => file.source === null)
  const opened = new Set<FileDescription>()
  const failure: [PathSpec, unknown][] = []
  // Open the statement's write targets, as bash's opens do before the command
  // runs: a `>` one emptied, a `>>` one created when it is missing; false, the
  // failure kept, when one cannot be opened. An output-only builtin's targets
  // wait for the write of its output instead (`outputOnly`).
  const openTargets = async (name = '', args: readonly string[] = []): Promise<boolean> => {
    if (outputOnly(name, args)) return true
    for (let file = opening.shift(); file !== undefined; file = opening.shift()) {
      try {
        await createFile(dispatch, session, file.scope, new Uint8Array(), file.append)
      } catch (error) {
        if (!isFsError(error)) throw error
        failure.push([file.scope, error])
        return false
      }
      opened.add(file)
    }
    return true
  }
  // A simple command opens its targets once dispatch has admitted it (see
  // runWithRedirectPaths); a compound one has no gate of its own and opens
  // them here, before its body runs.
  const simple = command !== null && command.type === NT.COMMAND
  const recorder = new Recorder()
  for (const file of files) {
    if (file.source !== null) continue
    for (const [fd, channel] of [
      [1, Channel.STDOUT],
      [2, Channel.STDERR],
    ] as const) {
      if (outputs.get(fd) === file) {
        file.emit = (data) => recorder.emit(channel, data)
        break
      }
    }
  }
  let unwound: Unwinding | null = null
  let refused = false
  let io = new IOResult()
  const saved = session.descriptors
  const claimed = new Set(redirects.flatMap((r) => (r.fd === FD_BOTH ? [1, 2] : [r.fd])))
  session.descriptors = new Map([
    ...saved,
    ...[...outputs]
      .filter(([fd]) => fd > 2 || claimed.has(fd))
      .map(
        ([fd, output]) =>
          [fd, describe(output, inputs.get(fd) ?? null, fd > 2 ? recorder : null)] as const,
      ),
  ])
  const targets = redirects
    .filter(
      (r) =>
        typeof r.target !== 'number' &&
        r.kind !== RedirectKind.HEREDOC &&
        r.kind !== RedirectKind.HERESTRING,
    )
    .map((r) => ensureScope(r.target))
  const terminalOutput = session.terminalOutput
  session.terminalOutput = terminalOutput && outputs.get(1) === TO_STDOUT
  const jobOutput = session.jobOutput
  const route = new JobRoute(recorder, outputs, jobOutput ?? session.tty.jobs, dispatch, session)
  session.jobOutput = route
  // A stream the statement redirects is its own while it runs, in the lines
  // it runs too (`eval`, `exec CMD`, `bash -c`): an earlier `exec >` binding
  // of it waits until the statement ends.
  const held = {
    ...(claimed.has(1)
      ? {
          execStdout: session.execStdout,
          execStdoutAppend: session.execStdoutAppend,
          execStdoutInput: session.execStdoutInput,
        }
      : {}),
    ...(claimed.has(2)
      ? {
          execStderr: session.execStderr,
          execStderrAppend: session.execStderrAppend,
          execStderrInput: session.execStderrInput,
        }
      : {}),
  }
  if (claimed.has(1)) Object.assign(session, EXEC_STREAM_UNBOUND[1])
  if (claimed.has(2)) Object.assign(session, EXEC_STREAM_UNBOUND[2])
  try {
    const given = inputs.get(0) ?? null
    if (command === null) {
      if (captureInput && given !== UNREADABLE) await pump(recorder, Channel.STDOUT, given)
    } else if (simple || (await runWithRedirectPaths(command, targets, openTargets))) {
      const [, execIo, execNode] = await drained(
        recorder,
        ...(await ENCLOSING.run(recorder, () =>
          runWithRedirectPaths(
            command,
            targets,
            () =>
              executeNode(
                command,
                context,
                given === UNREADABLE ? unreadableStdin() : given,
                callStack,
                { sink: recorder },
              ),
            simple ? openTargets : null,
          ),
        )),
      )
      io = execIo
      refused = execNode.refused
    }
  } catch (error) {
    if (!isUnwinding(error)) throw error
    unwound = error
    // What the command wrote on its way out goes where it writes; an error
    // expanding its own words came before its redirects.
    const output = takeStdout(error)
    if (output.byteLength > 0) await recorder.emit(Channel.STDOUT, output)
    const own =
      error instanceof ExitSignal && error.expanding !== null && error.expanding === command?.id
    if (!own) {
      const diagnostic = await takeStderr(error)
      if (diagnostic.byteLength > 0) await recorder.emit(Channel.STDERR, diagnostic)
    }
  } finally {
    Object.assign(session, held)
    // A body that raised (an abort, an error) skips the writes below: its
    // jobs write straight through.
    route.recorder = null
    session.jobOutput = jobOutput
    for (const file of files) file.emit = null
    session.terminalOutput = terminalOutput
    for (const fd of claimed) {
      const original = saved.get(fd)
      if (original !== undefined) session.descriptors.set(fd, original)
      else session.descriptors.delete(fd)
    }
  }
  let stdout: Uint8Array | null = null
  // What a job writes from here waits until the command's own output is
  // written (`route.release()`).
  route.recorder = new Recorder()
  try {
    const [stopped] = failure
    if (stopped !== undefined) return redirectFailure(...stopped)
    const chunks = recorder.chunks
    if (refused) {
      outputs.clear()
      outputs.set(0, CLOSED)
      outputs.set(1, TO_STDOUT)
      outputs.set(2, TO_STDERR)
      for (const r of redirects)
        if (typeof r.target === 'number') outputs.set(r.fd, outputs.get(r.target) ?? CLOSED)
    }
    if (
      outputs.get(1) === CLOSED &&
      command !== null &&
      chunks.some(([channel]) => channel === Channel.STDOUT)
    ) {
      chunks.push([Channel.STDERR, closedWriteLine(command, unwound)])
      io.exitCode = 1
    }
    const dest = (key: Channel | Inherited): FdDest | undefined => {
      if (!(key instanceof Inherited)) return outputs.get(key === Channel.STDOUT ? 1 : 2)
      if (key.owner !== recorder.owner) return key
      return key.channel === Channel.STDOUT ? TO_STDOUT : TO_STDERR
    }
    const routed: [Channel | Inherited, Uint8Array][] = []
    const writeFiles = async () => {
      const consumed = new Set<FileDescription>()
      let failedScope: PathSpec | null = null
      try {
        if (!refused)
          for (const file of files) {
            failedScope = file.scope
            const unique =
              files.filter((other) => other.scope.virtual === file.scope.virtual).length === 1
            const data = unique
              ? concat(chunks.filter(([key]) => dest(key) === file).map(([, data]) => data))
              : new Uint8Array()
            if (data.byteLength > 0 || !opened.has(file))
              await writeDescription(dispatch, session, file, data)
            else file.opened = true
            if (unique) {
              consumed.add(file)
              if (data.byteLength > 0) {
                io.writes[file.scope.virtual] = data
                io.cache = io.cache.filter((p) => p !== file.scope.virtual)
              }
            }
          }
        for (const [key, data] of chunks) {
          const target = dest(key)
          if (target === TO_STDOUT) routed.push([Channel.STDOUT, data])
          else if (target === TO_STDERR) routed.push([Channel.STDERR, data])
          else if (target instanceof Inherited) routed.push([target, data])
          else if (target instanceof FileDescription && !consumed.has(target)) {
            failedScope = target.scope
            await writeDescription(dispatch, session, target, data)
            io.writes[target.scope.virtual] = data
            io.cache = io.cache.filter((p) => p !== target.scope.virtual)
          }
        }
      } catch (error) {
        if (!isFsError(error) || failedScope === null) throw error
        routed.push([Channel.STDERR, redirectErrorLine(failedScope, error)])
        io.exitCode = 1
      }
    }
    if (command === null) await writeFiles()
    else await runWithRedirectPaths(command, targets, writeFiles)
    io.stderr = null
    const kept: [Channel, Uint8Array][] = []
    for (const [key, data] of routed) {
      if (key instanceof Inherited) {
        if (!(await deliver(sink ?? null, key, data))) kept.push([key.channel, data])
      } else if (sink !== undefined) await sink.emit(key, data)
      else kept.push([key, data])
    }
    if (sink !== undefined) for (const [channel, data] of kept) await sink.emit(channel, data)
    else {
      const joined = (channel: Channel): Uint8Array | null => {
        const data = concat(kept.filter(([c]) => c === channel).map(([, d]) => d))
        return data.byteLength === 0 ? null : data
      }
      stdout = joined(Channel.STDOUT)
      io.stderr = joined(Channel.STDERR)
    }
  } finally {
    await route.release()
  }
  if (unwound !== null) {
    if (unwound instanceof ExitSignal && unwound.replaced !== null && io.exitCode !== 0) {
      // The replacing program's own write failed: its status is the shell's.
      unwound.exitCode = io.exitCode
      unwound.containedCode = io.exitCode
    }
    throw await carried(unwound, stdout, new IOResult({ stderr: io.stderr }))
  }
  return [stdout, io, new ExecutionNode({ command: 'redirect', exitCode: io.exitCode, refused })]
}

/**
 * Whether an admitted command reads and writes no file of its own.
 *
 * Its write targets can then be opened by the write of its output: no read it
 * makes can see a target emptied early, and a target that cannot be opened
 * fails that write with the error the open would have met, the output dropped
 * and the status 1, which is what bash shows for a command it never ran.
 * `printf -v` assigns a variable a refused open must stop, so an option ahead
 * of the format opens first. Mirrors Python's `_output_only`.
 */
function outputOnly(name: string, args: readonly string[]): boolean {
  if (!OUTPUT_ONLY_BUILTINS.has(name)) return false
  return name !== 'printf' || args.length === 0 || !(args[0] ?? '').startsWith('-')
}

function descriptorOutput(descriptor: Descriptor): FdDest {
  if (descriptor.stream != null) return descriptor.stream
  if (descriptor.file !== null) return descriptor.file
  if (descriptor.identity === EXEC_TO_STDOUT) return TO_STDOUT
  if (descriptor.identity === EXEC_TO_STDERR) return TO_STDERR
  if (descriptor.identity.startsWith('/')) {
    const file = new FileDescription(ensureScope(descriptor.identity), true)
    file.opened = true
    return file
  }
  return CLOSED
}

/**
 * The binding a descriptor holds for the command a level runs. A copy of the
 * level's own stdout or stderr (`3>&1`) names it through `owner`, the level,
 * so it keeps reaching that stream when the command rebinds its own (`>f`);
 * fds 1 and 2 stay the command's. Mirrors Python's _describe.
 */
function describe(output: FdDest, source: Input, owner: Recorder | null): Descriptor {
  const input = source instanceof SharedInput ? source : null
  if (output instanceof Inherited)
    return {
      identity: output.channel === Channel.STDOUT ? EXEC_TO_STDOUT : EXEC_TO_STDERR,
      append: false,
      source: null,
      file: null,
      stream: output,
    }
  if (owner !== null && (output === TO_STDOUT || output === TO_STDERR))
    return {
      identity: output === TO_STDOUT ? EXEC_TO_STDOUT : EXEC_TO_STDERR,
      append: false,
      source: null,
      file: null,
      stream: new Inherited(owner.owner, output === TO_STDOUT ? Channel.STDOUT : Channel.STDERR),
    }
  if (output instanceof FileDescription)
    return {
      identity: (source instanceof FileInput ? OPEN_FOR_READ_WRITE : '') + output.scope.virtual,
      append: output.append,
      source: input,
      file: output,
    }
  const identity =
    output === TO_STDOUT
      ? EXEC_TO_STDOUT
      : output === TO_STDERR
        ? EXEC_TO_STDERR
        : input !== null
          ? OPEN_FOR_READING
          : EXEC_CLOSED
  return { identity, append: false, source: input, file: null }
}

/**
 * GNU stderr line for a redirect target that could not be opened.
 *
 * GNU bash 5.2.37 answers both `cat < missing` and `echo x > /nosuchdir/f`
 * with `bash: line 1: <target>: No such file or directory` and exit 1: the
 * error belongs to the shell, not the command, and the rest of the line keeps
 * running (`;` continues, `&&` short-circuits, `||` runs).
 *
 * Deliberate divergence from bash: the `bash: line N:` prefix is dropped, so
 * the line is `<target>: <strerror>`. This matches the house style already
 * set by the other shell-attributed error, `nosuchcmd: command not found`
 * (bash prints `bash: line 1: nosuchcmd: command not found`) — `bash:` is
 * bash's `$0` and mirage is not bash, and `line N` has no meaning for a
 * one-line `Workspace.shell` call.
 *
 * The label is the target's own spelling, never the error's message: backends
 * raise write failures with prose in the message (`parent directory does not
 * exist: /nodir`), which used to reach the user as the path.
 */
function redirectErrorLine(scope: PathSpec, err: unknown): Uint8Array {
  const strerror = fsStrerror(err)
  const label = scope.rawPath
  return encodeText(strerror !== null ? `${label}: ${strerror}\n` : `${label}\n`)
}

/**
 * GNU's line for a write onto a closed stdout, in the name of what wrote:
 * the command, or the program an `exec` in it replaced the shell with.
 */
function closedWriteLine(command: TSNodeLike, unwound: Unwinding | null = null): Uint8Array {
  const words = getText(command)
    .split(/\s+/)
    .filter((w) => w !== '')
  const name =
    unwound instanceof ExitSignal && unwound.replaced !== null
      ? unwound.replaced
      : (words[0] ?? 'redirect')
  return encodeText(`${name}: write error: Bad file descriptor\n`)
}

/** Shell-attributed IOResult for a redirect target that cannot be opened. */
function redirectFailure(scope: PathSpec, err: unknown): Result {
  const [stdout, io, node] = shellFailure(redirectErrorLine(scope, err))
  node.unopened = true
  return [stdout, io, node]
}

/**
 * Shell-attributed IOResult that replaces the command's whole run.
 *
 * bash never runs the command and stops processing redirects at the first
 * failure, so this replaces the whole result. Returning an IOResult rather
 * than rethrowing is what keeps the rest of the line alive.
 */
function shellFailure(line: Uint8Array, status = 1): Result {
  const io = new IOResult({ exitCode: status, stderr: line })
  return [null, io, new ExecutionNode({ command: 'redirect', exitCode: status })]
}

/** Whether a redirect target is a character device (`/dev/null`). */
async function isDevice(dispatch: DispatchFn, scope: PathSpec): Promise<boolean> {
  let stat: unknown
  try {
    ;[stat] = await dispatch('stat', scope)
  } catch (err) {
    if (!isFsError(err)) throw err
    return false
  }
  return stat instanceof FileStat && stat.type === FileType.CHAR_DEVICE
}

/**
 * Refuse the whole statement when one of its opens cannot happen.
 *
 * Returned *instead of* running the command, because that is what bash
 * does: it opens every redirect before it forks, so a refusal means the
 * command never runs. `set -C; touch marker > existing` leaves no marker
 * behind. Deciding this after the fact only matched the file contents,
 * and on `rm f > f` it did not even do that — the command deleted its
 * own target first, so the probe found nothing there and let the line
 * succeed.
 *
 * Two opens refuse. A target typed with a trailing slash is one whatever
 * is there: open(2) with O_CREAT answers `missing/` and `reg/` alike with
 * EISDIR before looking anything up, so bash prints `missing/: Is a
 * directory` and creates nothing, where writing the normalized name would
 * have left a regular file called `missing`. That test is on the spelling
 * alone and costs no round trip, which is a deliberate divergence for a
 * slashed target under a parent that is itself absent: bash reports the
 * parent first (ENOENT), this reads `Is a directory` too. The other is
 * `set -C`, described next.
 *
 * `set -C` refuses a truncating open onto anything that already exists —
 * an empty file counts, since the test is existence and not size — while
 * `>>` is always allowed and `>|` overrides for that one redirect without
 * clearing the option. A directory reached under the option is refused
 * too, in GNU's own wording for that case rather than the noclobber one.
 * bash stops at the first target it cannot open, so the scan reports one
 * line and stops.
 *
 * The opens are modelled in the order they were written, because each one
 * is visible to the next: `set -C; echo x > a > a` creates `a` on the
 * first redirect and then refuses the second, even though `a` did not
 * exist when the statement began. Probing every target against one
 * pre-command snapshot passed both and wrote the output. `>>` and `>|`
 * never refuse but do create, so they count as opens too.
 *
 * The stat is skipped unless the option is on, so the ordinary redirect
 * path costs no extra round trip. A directory typed without a slash needs
 * none here: the open itself answers `Is a directory`, from the kernel on
 * a real filesystem and from the store's own directory table on a keyed
 * one, and the write path renders it.
 *
 * Targets are stat'd through the op dispatcher rather than a backend, so
 * a redirect that lands on another mount is answered by the mount that
 * owns it.
 */
async function openRefusal(
  dispatch: DispatchFn,
  context: EvaluationContext,
  redirects: readonly Redirect[],
): Promise<Result | null> {
  const session = context.session
  const noclobber = session.shellOptions.noclobber === true
  const opened = new Set<string>()
  const pending: PathSpec[] = []
  for (const r of redirects) {
    if (
      r.kind === RedirectKind.STDIN ||
      r.kind === RedirectKind.READWRITE ||
      r.kind === RedirectKind.HEREDOC ||
      r.kind === RedirectKind.HERESTRING ||
      typeof r.target === 'number'
    ) {
      continue
    }
    const scope = ensureScope(r.target)
    if (scope.rawPath.endsWith('/')) {
      const earlier = await applyPendingOpens(dispatch, pending)
      if (earlier !== null) return earlier
      return shellFailure(encodeText(`${scope.rawPath}: Is a directory\n`))
    }
    const path = scope.virtual
    let exists = opened.has(path)
    let isDir = false
    if (noclobber && !exists) {
      let stat: unknown
      try {
        ;[stat] = await dispatch('stat', scope)
      } catch (err) {
        // No target to overwrite is the ordinary case the option allows;
        // anything that is not a filesystem error is a bug and propagates.
        if (!isFsError(err)) throw err
        stat = null
      }
      exists = stat instanceof FileStat
      isDir = stat instanceof FileStat && stat.type === FileType.DIRECTORY
    }
    if (noclobber && exists && !r.append && !r.clobber) {
      const earlier = await applyPendingOpens(dispatch, pending)
      if (earlier !== null) return earlier
      const detail = isDir ? posixPhrase('EISDIR') : 'cannot overwrite existing file'
      return shellFailure(encodeText(`${scope.rawPath}: ${detail}\n`))
    }
    // This open succeeds, so the target exists for every redirect after
    // it, and a truncating one leaves it empty to be found. Without the
    // option nothing was stat'd, so an append target of unknown standing
    // is not listed: pre-opening it with an empty write would truncate a
    // file that is there.
    opened.add(path)
    if (!r.append || (noclobber && !exists)) pending.push(scope)
  }
  return null
}

/**
 * Apply the opens a refused statement already performed.
 *
 * bash opens redirects left to right, so the ones before the refused one
 * have happened by the time it refuses: `set -C; echo x >> a > a` leaves
 * `a` existing and empty, and `>| a > a` truncates it. Only targets the
 * scan found absent, or opened for truncation, are listed, so an append
 * onto an existing file keeps its bytes.
 *
 * An earlier open that fails is the statement's refusal instead: bash stops
 * at the first open it cannot perform, so `echo x > /nodir/f > reg/` reports
 * `/nodir/f: No such file or directory` and never reaches the slashed target,
 * and the opens after the failed one are not performed either. Returns that
 * failure, or null when every open went through.
 */
async function applyPendingOpens(
  dispatch: DispatchFn,
  pending: PathSpec[],
): Promise<Result | null> {
  for (const scope of pending) {
    try {
      await dispatch('write', scope, [new Uint8Array()])
    } catch (err) {
      if (!isFsError(err)) throw err
      return redirectFailure(scope, err)
    }
  }
  return null
}

/** The descriptors an `exec` closed for the shell, which a line's dup
 * from refuses before the command runs. */
function persistentlyClosed(context: EvaluationContext): Set<number> {
  const session = context.session
  const closed = new Set<number>()
  if (session.execStdinIdentity === EXEC_CLOSED) closed.add(FD_STDIN)
  if (session.execStdout === EXEC_CLOSED) closed.add(FD_STDOUT)
  if (session.execStderr === EXEC_CLOSED) closed.add(FD_STDERR)
  return closed
}

/**
 * Where a write through fd 0 lands, read off the shell's bindings. Its
 * own read end, a closed descriptor and a file's read end take no write
 * (`echo x >&0` is bash's `write error: Bad file descriptor` with stdin a
 * pipe); a terminal stream dup'd onto it (`exec 0<&1`) writes where that
 * stream goes; a file opened for writing (`exec 0>f`) is the file.
 */
function stdinDest(context: EvaluationContext): FdDest | string {
  const session = context.session
  const id = session.execStdinIdentity
  if (id === null || id === EXEC_CLOSED || id.startsWith(OPEN_FOR_READING)) return CLOSED
  if (id === EXEC_TO_STDOUT) return TO_STDOUT
  if (id === EXEC_TO_STDERR) return TO_STDERR
  return id
}

function ensureScope(target: unknown): PathSpec {
  if (target instanceof PathSpec) return target
  if (typeof target === 'string') return toScope(target)
  return toScope(String(target))
}

function toScope(path: string): PathSpec {
  const lastSlash = path.lastIndexOf('/')
  const directory = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '/'
  return new PathSpec({ vfsPath: stripSlash(path), virtual: path, directory, resolved: true })
}
