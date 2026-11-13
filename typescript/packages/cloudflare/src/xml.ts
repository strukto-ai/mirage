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

import { DOMParser, Node } from '@xmldom/xmldom'

// The AWS SDK reads S3's XML replies through the web's DOMParser, which a
// browser has and a Worker does not: an S3-family mount lists and
// reads through this one there.
const web = globalThis as { DOMParser?: unknown; Node?: unknown }
web.DOMParser ??= DOMParser
web.Node ??= Node
