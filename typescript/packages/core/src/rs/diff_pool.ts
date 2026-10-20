import { Worker } from '../concurrency/worker.ts'
import { chunks } from '../io/cooperative.ts'
import { abortable, makeAbortError } from '../utils/abort.ts'
import { DiffReply, type DiffRequest } from './diff_worker.ts'
import type { DiffComputer, DiffOptions, InputFactory, PairResult } from './diff_types.ts'

export const CHUNK_SIZE = 64 * 1024
export const WORKER_LIMIT = 2
export const IDLE_TTL = 1000
export const QUEUE_LIMIT = 32
export const RETIRE_BYTES = 16 * 1024 * 1024

type EntryState =
  | { kind: 'leased'; abort: AbortController }
  | { kind: 'idle'; timer: ReturnType<typeof setTimeout> }
  | { kind: 'stopping'; completion: Promise<void> }
  | { kind: 'stop_failed'; error: Error }
interface Entry {
  readonly worker: Worker
  readonly inFlight: Set<Promise<unknown>>
  state: EntryState
}
interface Pending {
  readonly resolve: (entry: Entry) => void
  readonly reject: (error: Error) => void
  readonly detach: () => void
}

export class DiffPool implements DiffComputer {
  private readonly entries = new Set<Entry>()
  private readonly queue: Pending[] = []
  private readonly active = new Set<Promise<PairResult>>()
  private readonly cleanupErrors: unknown[] = []
  private stopped = false
  private closing: Promise<void> | undefined

  compare(
    options: DiffOptions,
    old: InputFactory,
    next: InputFactory,
    signal?: AbortSignal,
  ): Promise<PairResult> {
    const comparison = this.run(options, old, next, signal)
    this.active.add(comparison)
    void comparison.then(
      () => this.active.delete(comparison),
      () => this.active.delete(comparison),
    )
    return comparison
  }

  stop(): void {
    this.stopped = true
    for (const pending of this.queue.splice(0)) {
      pending.detach()
      pending.reject(new Error('diff pool is closed'))
    }
    for (const entry of this.entries) if (entry.state.kind === 'leased') entry.state.abort.abort()
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.stop()
    this.closing = this.closeAll()
    return this.closing
  }

  private async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.entries]
        .filter((entry) => entry.state.kind !== 'stop_failed')
        .map((entry) => this.retire(entry)),
    )
    await Promise.allSettled(
      [...this.entries]
        .filter((entry) => entry.state.kind === 'stop_failed')
        .map((entry) => this.retire(entry, true)),
    )
    await Promise.allSettled([...this.active])
    if (this.cleanupErrors.length > 0)
      throw new AggregateError(this.cleanupErrors, 'diff worker cleanup failed')
  }

  private acquire(signal?: AbortSignal): Promise<Entry> {
    if (this.stopped) return Promise.reject(new Error('diff pool is closed'))
    if (signal?.aborted === true) return Promise.reject(makeAbortError(signal))
    if (this.queue.length >= QUEUE_LIMIT)
      return Promise.reject(new Error('diff worker queue is full'))
    return new Promise<Entry>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.queue.indexOf(pending)
        if (index < 0) return
        this.queue.splice(index, 1)
        pending.detach()
        reject(makeAbortError(signal))
      }
      const pending: Pending = {
        resolve,
        reject,
        detach: () => signal?.removeEventListener('abort', onAbort),
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(pending)
      this.pump()
    })
  }

  private pump(): void {
    if (this.stopped) return
    while (this.queue.length > 0) {
      let entry = [...this.entries].find((item) => item.state.kind === 'idle')
      if (entry?.state.kind === 'idle') clearTimeout(entry.state.timer)
      else {
        if (this.entries.size >= WORKER_LIMIT) {
          if ([...this.entries].every((item) => item.state.kind === 'stop_failed')) {
            for (const pending of this.queue.splice(0)) {
              pending.detach()
              pending.reject(new Error('diff worker capacity is unavailable after failed cleanup'))
            }
          }
          return
        }
        entry = {
          worker: new Worker(),
          inFlight: new Set(),
          state: { kind: 'leased', abort: new AbortController() },
        }
        this.entries.add(entry)
      }
      const pending = this.queue.shift()
      if (pending === undefined) return
      entry.state = { kind: 'leased', abort: new AbortController() }
      pending.detach()
      pending.resolve(entry)
    }
  }

  private async run(
    options: DiffOptions,
    old: InputFactory,
    next: InputFactory,
    signal?: AbortSignal,
  ): Promise<PairResult> {
    const entry = await this.acquire(signal)
    if (entry.state.kind !== 'leased') throw new Error('diff worker lease is invalid')
    const combined =
      signal === undefined
        ? entry.state.abort.signal
        : AbortSignal.any([signal, entry.state.abort.signal])
    let success = false
    let bytes = 0
    const output: Uint8Array[] = []
    const stderr: Uint8Array[] = []
    const call = async (request: DiffRequest): Promise<DiffReply> => {
      const pending = entry.worker.call<unknown>('diffDispatch', [request], combined)
      entry.inFlight.add(pending)
      let raw: unknown
      try {
        raw = await pending
      } finally {
        entry.inFlight.delete(pending)
      }
      const reply = DiffReply.parse(raw)
      if (reply.kind === 'unavailable' || reply.kind === 'refusal') throw new Error(reply.message)
      if (reply.kind === 'output') {
        if (reply.output.byteLength > CHUNK_SIZE)
          throw new Error('diff worker output exceeds limit')
        if (reply.output.byteLength > 0) output.push(reply.output)
        bytes += reply.output.byteLength
      } else {
        if (reply.stderr.byteLength > CHUNK_SIZE)
          throw new Error('diff worker stderr exceeds limit')
        if (reply.stderr.byteLength > 0) stderr.push(reply.stderr)
        bytes += reply.stderr.byteLength
      }
      return reply
    }
    try {
      await call({ kind: 'open', options })
      for (const [index, factory] of [
        [0, old],
        [1, next],
      ] satisfies [0 | 1, InputFactory][]) {
        const source = await abortable(Promise.resolve().then(factory), combined)
        for await (const chunk of chunks(source, combined)) {
          bytes += chunk.byteLength
          await call({ kind: 'feed', index, chunk: new Uint8Array(chunk) })
        }
        await call({ kind: 'end', index })
      }
      for (;;) {
        const state = await call({ kind: 'inspect' })
        if (state.kind !== 'state') throw new Error('diff worker returned an invalid state')
        if (!state.busy) {
          if (state.status !== 2 && state.status !== (state.outcome === 'equal' ? 0 : 1))
            throw new Error('diff worker outcome disagrees with status')
          success = true
          return { outcome: state.outcome, status: state.status, output, stderr }
        }
        await call({ kind: 'drain' })
      }
    } finally {
      await this.release(entry, success, bytes)
    }
  }

  private async release(entry: Entry, success: boolean, bytes: number): Promise<void> {
    if (entry.state.kind === 'leased') {
      if (
        !success ||
        bytes > RETIRE_BYTES ||
        this.stopped ||
        (this.queue.length === 0 && [...this.entries].some((item) => item.state.kind === 'idle'))
      )
        await this.retire(entry)
      else {
        const timer = setTimeout(() => {
          if (entry.state.kind === 'idle' && entry.state.timer === timer)
            void this.retire(entry).catch(() => undefined)
        }, IDLE_TTL)
        entry.state = { kind: 'idle', timer }
        this.pump()
      }
    } else if (entry.state.kind === 'stopping') await entry.state.completion
  }

  private retire(entry: Entry, retry = false): Promise<void> {
    if (entry.state.kind === 'stopping') return entry.state.completion
    if (entry.state.kind === 'stop_failed' && !retry) return Promise.reject(entry.state.error)
    if (entry.state.kind === 'idle') clearTimeout(entry.state.timer)
    if (entry.state.kind === 'leased') entry.state.abort.abort()
    const completion = Promise.resolve()
      .then(async () => {
        const [stop] = await Promise.allSettled([entry.worker.close(retry), ...entry.inFlight])
        if (stop.status === 'rejected') throw stop.reason
        this.entries.delete(entry)
      })
      .catch((error: unknown) => {
        const failure =
          error instanceof Error ? error : new Error('diff worker cleanup failed', { cause: error })
        this.cleanupErrors.push(failure)
        entry.state = { kind: 'stop_failed', error: failure }
        throw failure
      })
      .finally(() => {
        this.pump()
      })
    entry.state = { kind: 'stopping', completion }
    return completion
  }
}
