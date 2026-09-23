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

export const SUPABASE_BROWSER_PROMPT = `{prefix}
  Remote Supabase Storage bucket accessed via presigned URLs (browser runtime).
  Supports the full filesystem command set: ls/tree/cat/grep/find/du/cp/mv/rm/etc.
  Listing operations require the presigner to sign LIST/COPY operations in
  addition to GET/PUT/HEAD/DELETE — see S3BrowserPresignedUrlProvider docs.`
