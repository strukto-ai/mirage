const computations: Record<string, () => Promise<unknown>> = {
  diffDispatch: async () => (await import('../rs/diff_worker.ts')).diffDispatch,
  scan: async () => (await import('../utils/regex_scan.ts')).scan,
  jqRunTexts: async () => (await import('../core/jq/eval.ts')).jqRunTexts,
}

interface Request {
  name: string
  args: unknown[]
}

async function execute(request: Request): Promise<{ ok: boolean; value: unknown }> {
  try {
    const load = computations[request.name]
    const fn = (await load?.()) as ((...args: unknown[]) => unknown) | undefined
    if (fn === undefined) throw new Error(`No computation named ${request.name}`)
    return { ok: true, value: await fn(...request.args) }
  } catch (error) {
    return { ok: false, value: error }
  }
}

// Replies keep arrival order even while a computation's module still loads.
const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node
if (node !== undefined) {
  const { parentPort } = await import('node:worker_threads')
  let replies = Promise.resolve()
  parentPort?.on('message', (request: Request) => {
    replies = replies.then(async () => {
      parentPort.postMessage(await execute(request))
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
      scope.postMessage(await execute(event.data))
    })
  }
}

export {}
