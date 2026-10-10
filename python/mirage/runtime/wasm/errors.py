# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from mirage.errors import FsCondition
from mirage.errors.wasi import wasi_errno
from mirage.runtime.constants import HARD_LINK_REFUSAL

OK = 0
EBADF = wasi_errno(FsCondition.EBADF)
EINVAL = wasi_errno(FsCondition.EINVAL)
EIO = wasi_errno(FsCondition.EIO)
ENOENT = wasi_errno(FsCondition.ENOENT)
ENOTDIR = wasi_errno(FsCondition.ENOTDIR)

# Which refusal a hard link gets is decided once, for every surface that
# can spell one; rendering it in preview1 numbers is this one's part.
LINK_REFUSAL = wasi_errno(HARD_LINK_REFUSAL)
