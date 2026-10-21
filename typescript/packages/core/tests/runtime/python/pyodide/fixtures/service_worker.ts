import { runInNewContext } from 'node:vm'
import { SCRIPT } from '../../../../../src/runtime/python/pyodide/worker/service_worker.ts'

type Listener = (event: unknown) => void

export interface ServiceWorker {
  /** The response the service worker gives a request, or null when it lets the request through. */
  fetch(request: Request): Promise<Response> | null
  message(data: unknown): void
  install(): void
  activate(): void
  readonly claims: number
  readonly skips: number
}

/**
 * The pyodide service worker, run against a scope that hands it events the
 * way a browser does; `updating` gives it an older version already active.
 */
export function serviceWorker(updating = false): ServiceWorker {
  const listeners = new Map<string, Listener>()
  let claims = 0
  let skips = 0
  const scope = {
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, listener)
    },
    registration: { active: updating ? {} : null },
    skipWaiting: () => {
      skips += 1
      return Promise.resolve()
    },
    clients: {
      claim: () => {
        claims += 1
        return Promise.resolve()
      },
    },
  }
  runInNewContext(SCRIPT, { self: scope, Response, URL })
  const extendable = { waitUntil: (work: Promise<unknown>) => void work }
  return {
    fetch(request) {
      const held: { response: Promise<Response> | Response | null } = { response: null }
      listeners.get('fetch')?.({
        request,
        respondWith: (answer: Promise<Response> | Response) => {
          held.response = answer
        },
      })
      return held.response === null ? null : Promise.resolve(held.response)
    },
    message(data) {
      listeners.get('message')?.({ data, ...extendable })
    },
    install() {
      listeners.get('install')?.(extendable)
    },
    activate() {
      listeners.get('activate')?.(extendable)
    },
    get claims() {
      return claims
    },
    get skips() {
      return skips
    },
  }
}
