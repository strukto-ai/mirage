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

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    import e2b


@runtime_checkable
class E2bSdk(Protocol):
    AsyncSandbox: type[e2b.AsyncSandbox]
    PtySize: type[e2b.PtySize]
    CommandExitException: type[e2b.CommandExitException]
    NotFoundException: type[Exception]
    SandboxException: type[Exception]
    SandboxNotFoundException: type[Exception]
    SandboxNotRunningException: type[Exception]
