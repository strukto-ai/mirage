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


class HeadMovedError(Exception):

    def __init__(self, branch: str) -> None:
        self.branch = branch
        super().__init__(
            f"branch {branch!r} moved since this commit was prepared; "
            "refusing to overwrite (re-read the head and retry)")


class NoSuchBranchError(Exception):

    def __init__(self, branch: str) -> None:
        self.branch = branch
        super().__init__(f"no branch {branch!r}; create it first with "
                         "`mirage workspace branch`")
