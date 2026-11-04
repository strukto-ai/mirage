/** A computation, and what it holds released when its worker stops. */
type Computation = ((...args: unknown[]) => unknown) & { close?: () => void }

// Each computation a worker runs, made once per worker, which keeps the
// state it holds between one call and the next.
const computations: Record<string, () => Promise<Computation>> = {
  diffDispatch: async () => (await import('../rs/diff_worker.ts')).diffDispatcher() as Computation,
}

export interface ComputationRequest {
  name: string
  args: unknown[]
  /** The mirage-rs module the page compiled, which the browser bundle leaves out. */
  wasm?: WebAssembly.Module
}

/** One worker's computations, each made on its first call. */
export type Computations = Map<string, Promise<Computation>>

/** `request` run against the worker's own `made` computations, as its reply. */
export async function execute(
  request: ComputationRequest,
  made: Computations,
): Promise<{ ok: boolean; value: unknown }> {
  try {
    if (request.wasm !== undefined) (await import('../rs/stream.ts')).adoptModule(request.wasm)
    const make = computations[request.name]
    if (make === undefined) throw new Error(`No computation named ${request.name}`)
    let fn = made.get(request.name)
    if (fn === undefined) {
      fn = make()
      made.set(request.name, fn)
    }
    return { ok: true, value: await (await fn)(...request.args) }
  } catch (error) {
    return { ok: false, value: error }
  }
}

/** Release what each of a worker's computations holds, as its worker stops. */
export async function closeAll(made: Computations): Promise<void> {
  const held = [...made.values()]
  made.clear()
  for (const fn of await Promise.allSettled(held)) {
    if (fn.status === 'fulfilled') fn.value.close?.()
  }
}
