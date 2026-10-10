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

import sys

# setxattr(2)'s flags as the kernel hands them over: linux numbers
# XATTR_CREATE 1 and XATTR_REPLACE 2, macOS 2 and 4 (its 1 is
# XATTR_NOFOLLOW, which the kernel has already applied).
XATTR_CREATE, XATTR_REPLACE = (
    (0x2, 0x4) if sys.platform == "darwin" else (0x1, 0x2)
)
