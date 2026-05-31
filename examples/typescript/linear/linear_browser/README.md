# Browser Linear demo

Demonstrates the browser `LinearResource` calling `api.linear.app/graphql` directly — no proxy server. Linear's GraphQL API supports CORS and uses an `Authorization` header, so the browser can talk to it directly (mirroring how the browser `S3Resource` signs requests with credentials it holds).

## Run

```bash
pnpm tsx examples/typescript/linear/linear_browser/main.ts
```

`LINEAR_API_KEY` must be set (e.g. via `.env.development` at the repo root).

## Production note

Embedding `apiKey` in shipped client code is fine for personal tools, internal dashboards, or post-OAuth flows where the token is already user-scoped. For untrusted clients, route through your own server using the `baseUrl` config option to point at a proxy that injects the credential server-side.
