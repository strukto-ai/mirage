// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { defineConfig, type ViteDevServer } from 'vite'
import { handlePresign } from './scripts/presigner.ts'
import { handleMongoProxy } from './scripts/mongo_proxy.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(here, '../../../.env.development') })

export default defineConfig({
  optimizeDeps: {
    exclude: ['@struktoai/mirage-browser', '@struktoai/mirage-core'],
  },
  define: {
    __TRELLO_API_KEY__: JSON.stringify(process.env.TRELLO_API_KEY ?? ''),
    __TRELLO_API_TOKEN__: JSON.stringify(process.env.TRELLO_API_TOKEN ?? ''),
    __LINEAR_API_KEY__: JSON.stringify(process.env.LINEAR_API_KEY ?? ''),
    __GITHUB_TOKEN__: JSON.stringify(process.env.GITHUB_TOKEN ?? ''),
    __GITHUB_OWNER__: JSON.stringify(process.env.GITHUB_OWNER ?? ''),
    __GITHUB_REPO__: JSON.stringify(process.env.GITHUB_REPO ?? ''),
    __GOOGLE_CLIENT_ID__: JSON.stringify(process.env.GOOGLE_CLIENT_ID ?? ''),
    __GOOGLE_CLIENT_SECRET__: JSON.stringify(process.env.GOOGLE_CLIENT_SECRET ?? ''),
    __GOOGLE_REFRESH_TOKEN__: JSON.stringify(process.env.GOOGLE_REFRESH_TOKEN ?? ''),
    __LANGFUSE_PUBLIC_KEY__: JSON.stringify(process.env.LANGFUSE_PUBLIC_KEY ?? ''),
    __LANGFUSE_SECRET_KEY__: JSON.stringify(process.env.LANGFUSE_SECRET_KEY ?? ''),
    __LANGFUSE_HOST__: JSON.stringify(process.env.LANGFUSE_HOST ?? ''),
    __SEMANTIC_SCHOLAR_API_KEY__: JSON.stringify(process.env.SEMANTIC_SCHOLAR_API_KEY ?? ''),
    __DROPBOX_CLIENT_ID__: JSON.stringify(process.env.DROPBOX_CLIENT_ID ?? ''),
    __BOX_CLIENT_ID__: JSON.stringify(process.env.BOX_CLIENT_ID ?? ''),
  },
  server: {
    port: 5173,
    fs: {
      allow: ['../../..'],
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      // Optional monty runtime: its browser entry imports
      // @bjorn3/browser_wasi_shim without declaring it, so bundling it
      // breaks. Left external, selecting monty fails into the exit-127
      // "runtime unavailable" path at runtime instead.
      external: ['@pydantic/monty'],
      input: {
        main: resolve(here, 'index.html'),
        mongodb: resolve(here, 'mongodb.html'),
        gdocs_pkce: resolve(here, 'gdocs_pkce.html'),
        gdrive_pkce: resolve(here, 'gdrive_pkce.html'),
        dropbox_pkce: resolve(here, 'dropbox_pkce.html'),
        box_pkce: resolve(here, 'box_pkce.html'),
      },
    },
  },
  assetsInclude: ['**/*.wasm'],
  plugins: [
    {
      name: 'mirage-presigner',
      configureServer(server: ViteDevServer) {
        server.middlewares.use((req, res, next) => {
          handlePresign(req, res)
            .then((handled) => {
              if (!handled) next()
            })
            .catch((err: unknown) => {
              res.statusCode = 500
              res.end(err instanceof Error ? err.message : String(err))
            })
        })
      },
    },
    {
      name: 'mirage-mongo-proxy',
      configureServer(server: ViteDevServer) {
        server.middlewares.use((req, res, next) => {
          handleMongoProxy(req, res)
            .then((handled) => {
              if (!handled) next()
            })
            .catch((err: unknown) => {
              res.statusCode = 500
              res.end(err instanceof Error ? err.message : String(err))
            })
        })
      },
    },
  ],
})
