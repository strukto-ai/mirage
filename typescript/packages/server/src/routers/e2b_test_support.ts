import type { MirageApp } from '../app.ts'

export function e2bListener(app: MirageApp) {
  if (app.e2b === null) throw new Error('E2B listener is disabled in the test app')
  return app.e2b
}
