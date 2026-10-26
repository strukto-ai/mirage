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

import { wasiErrno } from '../../errors/wasi.ts'
import { HARD_LINK_REFUSAL } from '../constants.ts'

export const OK = 0
export const ELOOP = wasiErrno('ELOOP')
export const ESPIPE = 70
export const EBADF = wasiErrno('EBADF')
export const EINVAL = wasiErrno('EINVAL')
export const EIO = wasiErrno('EIO')
export const ENOENT = wasiErrno('ENOENT')
export const ENOTDIR = wasiErrno('ENOTDIR')
export const EPIPE = wasiErrno('EPIPE')

// Which refusal a hard link gets is decided once, for every surface that
// can spell one; rendering it in preview1 numbers is this one's part.
export const LINK_REFUSAL = wasiErrno(HARD_LINK_REFUSAL)
