import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import type { FastifyReply } from 'fastify'
import { CHUNK_SIZE } from '@struktoai/mirage-core/io/cooperative'
import type { StreamName } from '@struktoai/mirage-core/io/types'
import type { ShellExecution } from '@struktoai/mirage-core/workspace/shell_execution'
import type { ExecutionTable } from './jobs.ts'
import type { ExecutionRecord } from '@struktoai/mirage-core/execution/types'
import { UploadStdin } from './stdin.ts'

export const PAYLOAD_SIZE = CHUNK_SIZE / 2

/**
 * One output event as wire records, a line each, every one holding at most
 * PAYLOAD_SIZE bytes of it. Mirrors Python's `record`.
 */
export function record(stream: StreamName, data: Uint8Array): Uint8Array {
  const lines: string[] = []
  for (let offset = 0; offset < data.byteLength; offset += PAYLOAD_SIZE) {
    const part = Buffer.from(data.subarray(offset, offset + PAYLOAD_SIZE)).toString('base64')
    lines.push(JSON.stringify({ stream, data: part }) + '\n')
  }
  return Buffer.from(lines.join(''))
}

/**
 * Stream one job and retain its existing owner through disconnect cleanup.
 * The job opens the line's execution and waits for its status; the body
 * reads the execution's events and sends each as its records, so a caller
 * that reads slowly holds the line back. The final record goes out as soon
 * as the job settles: stdin the line did not read never ends a line, as
 * `ssh host cmd` returns while its input is still open. The body then ends
 * only once the rest of the upload is discarded or the caller hangs up, so
 * the caller finishes sending before the connection closes. Mirrors
 * Python's `ShellResponse`.
 */
export function shellResponse(
  execution: Promise<ShellExecution | null>,
  jobs: ExecutionTable,
  job: ExecutionRecord,
  reply: FastifyReply,
  failed: Promise<unknown>,
  stdin: UploadStdin | Uint8Array | undefined,
): FastifyReply {
  const finished = jobs.wait(job.id)
  const completed = jobs.drain(job.id).then(() => finished)
  void completed.catch((error: unknown) => {
    reply.log.error(error, 'streamed shell completion failed')
  })
  let shell: ShellExecution | null = null
  void execution.then((opened) => {
    shell = opened
  })
  const disconnected = (): void => {
    // The job is cancelled first, so it ends as cancelled rather than as
    // the failure its closed execution would report.
    jobs.cancel(job.id)
    void shell?.close()
    if (stdin instanceof UploadStdin)
      void stdin.discard().catch((error: unknown) => {
        reply.log.error(error, 'stdin cleanup failed')
      })
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
      const opened = await execution
      if (opened !== null) {
        try {
          for await (const event of opened.events) yield record(event.stream, event.data)
        } catch (error) {
          // The line failed or was stopped: its status says so in the
          // final record.
          reply.log.debug(error, 'streamed shell output ended')
        }
      }
      const result = await completed
      if (stdin instanceof UploadStdin && stdin.error !== undefined) uploadError = stdin.error
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
      if (stdin instanceof UploadStdin) await stdin.discard()
      jobs.cancel(job.id)
      try {
        await jobs.drain(job.id)
      } finally {
        await (await execution)?.close()
        reply.raw.off('close', disconnected)
      }
    }
  }
  return reply
    .header('connection', 'close')
    .type('application/x-ndjson')
    .send(Readable.from(body(), { objectMode: false, highWaterMark: CHUNK_SIZE }))
}
