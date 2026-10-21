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

// A PTY carries a served prefix's SFTP where a provider's exec decodes
// output as text (E2B): the terminal goes raw, so bytes pass unchanged,
// and the marker ends the shell's own output before sshfs starts.
export const PTY_MARK = new Uint8Array([1, ...new TextEncoder().encode('mirage-sftp'), 2])
export const PTY_RAW = "stty raw -echo -iexten; printf '\\001mirage-sftp\\002'; "
