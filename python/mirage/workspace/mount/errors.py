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


class WritePolicyError(ValueError):
    """A write policy a mount or snapshot cannot take, refused at load."""


class SharedStorageError(ValueError):
    """A mount would expose storage another mount of the workspace already does."""

    def __init__(
        self, prefix: str, existing: str, location: str | None
    ) -> None:
        what = "this VFS" if location is None else location
        hint = "; mount a separate VFS instead" if location is None else ""
        super().__init__(
            f"mount {prefix}: {what} is already mounted at {existing}{hint}"
        )


class MountCommandAmbiguous(ValueError):
    """A pathless write has more than one eligible mount."""

    def __init__(self, cmd_name: str, prefixes: list[str]) -> None:
        candidates = "\n".join(f"  {p.rstrip('/') or '/'}" for p in prefixes)
        super().__init__(
            f"{cmd_name}: ambiguous, registered on {len(prefixes)} writable mounts:\n"
            f"{candidates}\n"
            "cd into the target mount to disambiguate."
        )
