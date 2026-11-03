import { type ComputationRequest as Request, type Computations, execute } from './computations.ts'

// A thread is one worker, so its computations are the module's own.
const made: Computations = new Map()

// Replies keep arrival order even while a computation's module still loads.
const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node
if (node !== undefined) {
  const { parentPort } = await import('node:worker_threads')
  let replies = Promise.resolve()
  parentPort?.on('message', (request: Request) => {
    replies = replies.then(async () => {
      parentPort.postMessage(await execute(request, made))
    })
  })
} else {
  const scope = globalThis as unknown as {
    onmessage: (event: MessageEvent<Request>) => void
    postMessage(data: unknown): void
  }
  let replies = Promise.resolve()
  scope.onmessage = (event) => {
    replies = replies.then(async () => {
      scope.postMessage(await execute(event.data, made))
    })
  }
}

export {}
