# Browser examples

`@struktoai/mirage-browser` examples, laid out like `examples/typescript/`.
`index.html` and `src/main.ts` are the multi-mount demo page, `vfs/<backend>/`
holds one directory per backend, `runtime/pyodide/` runs Pyodide on a page
that is not cross-origin isolated, and `scripts/` the dev-server helpers and
Playwright smoke tests. In a backend directory, an `.html` file and the
`.ts` file of the same name are a page the dev server serves, `main.ts` runs
the browser package under Node, and `server.ts` is the proxy a backend
without CORS needs.

```bash
cd typescript && pnpm --filter @struktoai/mirage-browser build
cd ../examples/browser && pnpm dev                   # http://localhost:5173/
pnpm exec tsx vfs/github/main.ts                     # a Node run
```
