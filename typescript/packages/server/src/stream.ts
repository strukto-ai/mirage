import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import type { FastifyReply } from 'fastify'
import { CHUNK_SIZE } from '@struktoai/mirage-core/io/cooperative'
import { CAPACITY, BytePipe } from '@struktoai/mirage-core/io/pipe'
import type { StreamName } from '@struktoai/mirage-core/io/types'
import type { JobEntry, JobTable } from './jobs.ts'
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

  async emit(stream: StreamName, data: Uint8Array): Promise<void> {
    const previous = this.writing
    let release!: () => void
    this.writing = new Promise((resolve) => {
      release = resolve
    })
    await previous
    try {
      for (let offset = 0; offset < data.byteLength; offset += PAYLOAD_SIZE) {
        await this.pipe.write(
          Buffer.from(
            JSON.stringify({
              stream,
              data: Buffer.from(data.subarray(offset, offset + PAYLOAD_SIZE)).toString('base64'),
            }) + '\n',
          ),
        )
      }
    } finally {
      release()
    }
  }
}

/**
 * Stream one job and retain its existing owner through disconnect cleanup.
 * The final record waits for the rest of the upload, discarded, as the
 * foreground reply does, so the caller finishes sending before the
 * connection closes.
 */
export function shellResponse(
  output: ShellOutput,
  jobs: JobTable,
  job: JobEntry,
  reply: FastifyReply,
  failed: Promise<unknown>,
  stdin: UploadStdin | Uint8Array | undefined,
): FastifyReply {
  const completed = jobs
    .drain(job.id)
    .then(() => jobs.wait(job.id))
    .finally(() => {
      output.pipe.end()
    })
  void completed.catch((error: unknown) => {
    reply.log.error(error, 'streamed shell completion failed')
  })
  const disconnected = (): void => {
    output.pipe.closeReader()
    if (stdin instanceof UploadStdin) stdin.discard()
    jobs.cancel(job.id)
  }
  reply.raw.once('close', disconnected)
  void failed.then((error) => {
    if (error !== undefined) {
      reply.log.debug(error, 'streamed shell upload failed')
      disconnected()
    }
  })
  async function* body(): AsyncGenerator<Uint8Array> {
    try {
      yield* output.pipe.stream()
      const result = await completed
      if (stdin instanceof UploadStdin) stdin.discard()
      await failed
      yield Buffer.from(
        JSON.stringify({
          status: result.status,
          result: result.result,
          error: result.error,
        }) + '\n',
      )
    } finally {
      output.pipe.closeReader()
      if (stdin instanceof UploadStdin) stdin.discard()
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
