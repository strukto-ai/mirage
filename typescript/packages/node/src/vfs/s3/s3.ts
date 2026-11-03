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

import { S3VFS } from '@struktoai/mirage-core/vfs/direct/s3'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'

// Node has sockets of its own, so an S3-family mount's `proxy` works here.
S3VFS.proxyAgents = (proxy) => ({
  httpAgent: new HttpProxyAgent(proxy),
  httpsAgent: new HttpsProxyAgent(proxy),
})

export { S3VFS }
