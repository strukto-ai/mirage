import { writeFileSync } from 'node:fs'
import { SCRIPT } from '@struktoai/mirage-core/runtime/python/pyodide/worker/service_worker'

// A service worker has to be a file the page's own origin serves, so the
// one pyodide needs on a page without shared memory ships as a file the
// page copies.
writeFileSync(new URL('../dist/pyodide-sw.js', import.meta.url), SCRIPT)
