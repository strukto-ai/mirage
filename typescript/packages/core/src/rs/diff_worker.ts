import { openStream, type OpenStream } from './stream.ts'
import { StreamRefusal } from './errors.ts'
import { z } from 'zod'

const Options = z.object({
  mode: z.enum(['normal', 'unified', 'ed', 'context', 'rcs', 'sides']),
  context: z.number().int().nonnegative(),
  ignore_case: z.boolean(),
  ignore_all_space: z.boolean(),
  ignore_space_change: z.boolean(),
  ignore_tab_expansion: z.boolean(),
  ignore_trailing_space: z.boolean(),
  strip_trailing_cr: z.boolean(),
  ignore_blank_lines: z.boolean(),
  ignore_lines: z.array(z.string()),
  function_lines: z.array(z.string()),
  show_c_function: z.boolean(),
  expand_tabs: z.boolean(),
  initial_tab: z.boolean(),
  widths: z.array(z.string()),
  suppress_common: z.boolean(),
  left_column: z.boolean(),
  text: z.boolean(),
  brief: z.boolean(),
  utf8: z.boolean(),
  old_label: z.string(),
  new_label: z.string(),
  old_header: z.string(),
  new_header: z.string(),
})

const Bytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array)
export const DiffRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open'), options: Options }),
  z.object({ kind: z.literal('feed'), index: z.union([z.literal(0), z.literal(1)]), chunk: Bytes }),
  z.object({ kind: z.literal('end'), index: z.union([z.literal(0), z.literal(1)]) }),
  z.object({ kind: z.literal('drain') }),
  z.object({ kind: z.literal('inspect') }),
  z.object({ kind: z.literal('close') }),
])
export type DiffRequest = z.infer<typeof DiffRequest>

export const DiffOutcome = z.object({ outcome: z.enum(['equal', 'different']) })
export const DiffReply = z.discriminatedUnion('kind', [
  // `wants`: the input the stream reads next, null once it reads neither.
  z.object({
    kind: z.literal('output'),
    output: Bytes,
    wants: z.union([z.literal(0), z.literal(1)]).nullable(),
  }),
  z.object({
    kind: z.literal('state'),
    busy: z.boolean(),
    status: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    stderr: Bytes,
    outcome: z.enum(['equal', 'different']),
  }),
  z.object({ kind: z.literal('refusal'), message: z.string(), output: Bytes }),
  z.object({ kind: z.literal('unavailable'), message: z.string() }),
])
export type DiffReply = z.infer<typeof DiffReply>

const DEC = new TextDecoder()

function refusalReply(error: unknown): DiffReply {
  if (!(error instanceof StreamRefusal)) throw error
  return { kind: 'refusal', message: error.message, output: error.output }
}

/**
 * A diff dispatcher holding the one stream its worker compares through. A
 * thread has a dispatcher of its own; a host without threads makes one per
 * worker, so two diffs in the same thread never share a stream.
 */
export function diffDispatcher(): ((raw: unknown) => Promise<DiffReply>) & { close(): void } {
  let stream: OpenStream | undefined
  const dispatch = async (raw: unknown): Promise<DiffReply> => {
    const request = DiffRequest.parse(raw)
    try {
      const output = (bytes: Uint8Array): DiffReply =>
        DiffReply.parse({ kind: 'output', output: bytes, wants: stream?.wants() ?? null })
      if (request.kind === 'close' || request.kind === 'open') {
        stream?.close()
        stream = undefined
        if (request.kind === 'open') {
          stream = await openStream('diff', { ...request.options })
        }
        return output(new Uint8Array())
      }
      if (stream === undefined) throw new Error('diff stream is not open')
      switch (request.kind) {
        case 'feed':
          return output(stream.feedInput(request.index, request.chunk))
        case 'end':
          return output(stream.endInput(request.index))
        case 'drain':
          return output(stream.drain())
        case 'inspect': {
          const metadata = DiffOutcome.parse(JSON.parse(DEC.decode(stream.metadata())))
          const reply = {
            kind: 'state',
            busy: stream.busy(),
            status: z.union([z.literal(0), z.literal(1), z.literal(2)]).parse(stream.status()),
            stderr: stream.takeStderr(),
            outcome: metadata.outcome,
          } satisfies DiffReply
          if (!reply.busy) {
            stream.close()
            stream = undefined
          }
          return reply
        }
      }
    } catch (error) {
      if (
        request.kind === 'open' &&
        (error instanceof WebAssembly.CompileError || error instanceof WebAssembly.LinkError)
      )
        return {
          kind: 'unavailable',
          message: `cannot initialize the Rust diff module: ${error.message}`,
        }
      if (!(error instanceof StreamRefusal)) throw error
      stream?.close()
      stream = undefined
      return refusalReply(error)
    }
  }
  // A worker retired mid-comparison sends no `close`; its stream goes here.
  const close = (): void => {
    stream?.close()
    stream = undefined
  }
  return Object.assign(dispatch, { close })
}
