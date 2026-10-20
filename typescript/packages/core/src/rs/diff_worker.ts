import { openStream, type OpenStream } from './stream.ts'
import { StreamRefusal } from './errors.ts'
import { z } from 'zod'

const Options = z.object({
  mode: z.enum(['normal', 'unified', 'ed']),
  context: z.number().int().nonnegative(),
  ignore_case: z.boolean(),
  ignore_all_space: z.boolean(),
  ignore_space_change: z.boolean(),
  text: z.boolean(),
  brief: z.boolean(),
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
  z.object({ kind: z.literal('output'), output: Bytes }),
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
let stream: OpenStream | undefined

function refusalReply(error: unknown): DiffReply {
  if (!(error instanceof StreamRefusal)) throw error
  return { kind: 'refusal', message: error.message, output: error.output }
}

export async function diffDispatch(raw: unknown): Promise<DiffReply> {
  const request = DiffRequest.parse(raw)
  try {
    if (request.kind === 'close' || request.kind === 'open') {
      stream?.close()
      stream = undefined
      if (request.kind === 'open') {
        stream = await openStream('diff', { ...request.options })
      }
      return { kind: 'output', output: new Uint8Array() }
    }
    if (stream === undefined) throw new Error('diff stream is not open')
    switch (request.kind) {
      case 'feed':
        return { kind: 'output', output: stream.feedInput(request.index, request.chunk) }
      case 'end':
        return { kind: 'output', output: stream.endInput(request.index) }
      case 'drain':
        return { kind: 'output', output: stream.drain() }
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
