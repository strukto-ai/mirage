import { abortable } from '@struktoai/mirage-core/utils/abort'
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import type { FastifyReply } from 'fastify'
import { CHUNK_SIZE } from '@struktoai/mirage-core/io/cooperative'
import { CAPACITY, BytePipe } from '@struktoai/mirage-core/io/pipe'
import type { StreamName } from '@struktoai/mirage-core/io/types'
import type { ExecutionTable } from './jobs.ts'
import type { ExecutionRecord } from '@struktoai/mirage-core/execution/types'
import { UploadStdin } from './stdin.ts'

const PAYLOAD_SIZE = CHUNK_SIZE / 2

/**
 * A streamed shell's output records; each encoded record fits one pipe
 * chunk, so cancelling a blocked write cannot leave an incomplete record.
 */
export class ShellOutput {
  readonly pipe: BytePipe
  private writing: Promise<void> = Promise.resolve()

  constructor(capacity = CAPACITY) {
    this.pipe = new BytePipe(capacity)
  }

  async emit(stream: StreamName, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    const previous = this.writing
    let release!: () => void
    this.writing = new Promise((resolve) => {
      release = resolve
    })
    try {
      await abortable(previous, signal)
      for (let offset = 0; offset < data.byteLength; offset += PAYLOAD_SIZE) {
        await this.pipe.write(
          Buffer.from(
            JSON.stringify({
              stream,
              data: Buffer.from(data.subarray(offset, offset + PAYLOAD_SIZE)).toString('base64'),
            }) + '\n',
          ),
          signal,
        )
      }
    } finally {
      release()
    }
  }
}

/**
 * Stream one job and retain its existing owner through disconnect cleanup.
 * The final record goes out as soon as the job settles: stdin the line did
 * not read never ends a line, as `ssh host cmd` returns while its input is
 * still open. The body then ends only once the rest of the upload is
 * discarded or the caller hangs up, so the caller finishes sending before
 * the connection closes.
 */
export function shellResponse(
  output: ShellOutput,
  jobs: ExecutionTable,
  job: ExecutionRecord,
  reply: FastifyReply,
  failed: Promise<unknown>,
  stdin: UploadStdin | Uint8Array | undefined,
): FastifyReply {
  const finished = jobs.wait(job.id)
  const completed = jobs
    .drain(job.id)
    .then(() => finished)
    .finally(() => {
      output.pipe.end()
    })
  void completed.catch((error: unknown) => {
    reply.log.error(error, 'streamed shell completion failed')
  })
  const disconnected = (): void => {
    output.pipe.closeReader()
    if (stdin instanceof UploadStdin)
      void stdin.discard().catch((error: unknown) => {
        reply.log.error(error, 'stdin cleanup failed')
      })
    jobs.cancel(job.id)
  }
  reply.raw.once('close', disconnected)
  let uploadError: unknown
  void failed.then((error) => {
    uploadError = error
    if (error !== undefined) {
      reply.log.debug(error, 'streamed shell upload failed')
      disconnected()
    }
  })
  async function* body(): AsyncGenerator<Uint8Array> {
    try {
      yield* output.pipe.stream()
      const result = await completed
      yield Buffer.from(
        JSON.stringify({
          status: uploadError === undefined ? result.status : 'failed',
          result: uploadError === undefined ? result.result : null,
          error:
            uploadError === undefined
              ? result.error
              : uploadError instanceof Error
                ? uploadError.message
                : 'Upload failed',
        }) + '\n',
      )
      if (stdin instanceof UploadStdin) await stdin.discard()
      await failed
    } finally {
      output.pipe.closeReader()
      if (stdin instanceof UploadStdin) await stdin.discard()
      jobs.cancel(job.id)
      try {
        await jobs.drain(job.id)
      } finally {
        reply.raw.off('close', disconnected)
      }
    }
  }
  return reply
    .header('connection', 'close')
    .type('application/x-ndjson')
    .send(Readable.from(body(), { objectMode: false, highWaterMark: CHUNK_SIZE }))
}
