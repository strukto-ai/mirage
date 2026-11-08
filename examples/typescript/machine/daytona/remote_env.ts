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

import { Image } from '@daytona/sdk'

export const MIRAGE_GIT_SPEC =
  'mirage-ai[s3] @ git+https://github.com/strukto-ai/mirage.git#subdirectory=python'

export function remoteEnv(): Record<string, string> {
  const required = ['AWS_S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']
  for (const key of required) {
    if (process.env[key] === undefined) {
      throw new Error(`${key} not set (expected in .env.development)`)
    }
  }
  return {
    AWS_S3_BUCKET: process.env.AWS_S3_BUCKET as string,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID as string,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY as string,
  }
}

export function baseImage(): Image {
  return Image.debianSlim('3.12')
    .runCommands(
      'apt-get update ' +
        '&& apt-get install -y --no-install-recommends git ' +
        '&& rm -rf /var/lib/apt/lists/*',
    )
    .pipInstall(MIRAGE_GIT_SPEC)
}

export function fuseImage(): Image {
  return Image.debianSlim('3.12')
    .runCommands(
      'apt-get update ' +
        '&& apt-get install -y --no-install-recommends ' +
        '    git fuse3 libfuse3-dev ' +
        "&& sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf " +
        '&& rm -rf /var/lib/apt/lists/*',
    )
    .pipInstall(MIRAGE_GIT_SPEC)
}
