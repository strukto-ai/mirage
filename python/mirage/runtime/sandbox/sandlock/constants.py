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

SANDLOCK_CLI_HINT = (
    "the sandlock runtime needs the sandlock CLI on PATH "
    "(https://github.com/multikernel/sandlock); Linux only, and the full "
    "ruleset wants Landlock ABI v6 (Linux 6.12+)")

# Common loader/runtime paths. Non-system installations need explicit grants.
SYSTEM_READABLE: tuple[str, ...] = ("/usr", "/lib", "/lib64", "/bin", "/etc",
                                    "/proc", "/dev")
