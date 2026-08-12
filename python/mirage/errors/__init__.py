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

from mirage.errors.classify import classify
from mirage.errors.guest import GUEST, guest_seat
from mirage.errors.posix import POSIX, gnu_phrase, posix_errno
from mirage.errors.types import FsCondition, GuestSeat, PosixSeat
from mirage.errors.wasi import WASI, wasi_errno

__all__ = [
    "GUEST",
    "POSIX",
    "WASI",
    "FsCondition",
    "GuestSeat",
    "PosixSeat",
    "classify",
    "gnu_phrase",
    "guest_seat",
    "posix_errno",
    "wasi_errno",
]
