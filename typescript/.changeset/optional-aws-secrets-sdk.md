---
'@struktoai/mirage-node': minor
---

`@aws-sdk/client-secrets-manager` is now an optional peer dependency, like `@1password/sdk`, so installs that never read from AWS Secrets Manager no longer pull it in. A workspace that declares the `aws-sm` source needs `npm install @aws-sdk/client-secrets-manager`, and without it fails when the workspace is built, naming the package to install.
