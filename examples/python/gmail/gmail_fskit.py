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

import os

from dotenv import load_dotenv

from mirage import Mount, MountBackend, MountMode, Workspace
from mirage.resource.gmail import GmailConfig, GmailResource
from mirage.resource.ram import RAMResource

load_dotenv(".env.development")

config = GmailConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)

# Gmail reports sizeEstimate for a message, but that is the RFC822 source
# size, not the length of the .gmail.json mirage renders. Reporting it would
# make wc -c lie and risk truncated copies, so stat() returns None and the
# real number lives in extra["size_estimate"]. That makes Gmail a
# size-unknown resource, which fskit cannot serve.
print("=== part 1: fskit refuses gmail ===\n")
try:
    with Workspace({
            "/gmail/":
            Mount(GmailResource(config=config),
                  mode=MountMode.READ,
                  backend=MountBackend.FSKIT)
    }):
        print("  unexpectedly mounted")
except RuntimeError as err:
    print(f"  refused as designed:\n  {err}\n")

# A mixed workspace is refused by name too: the guard reports every mount
# that would break, not just the first.
print("=== part 2: a mixed workspace names every offender ===\n")
try:
    with Workspace({
            "/ram/":
            Mount(RAMResource(),
                  mode=MountMode.WRITE,
                  backend=MountBackend.FSKIT),
            "/gmail/":
            Mount(GmailResource(config=config), mode=MountMode.READ),
    }):
        print("  unexpectedly mounted")
except RuntimeError as err:
    print(f"  refused as designed:\n  {err}\n")

# Scoping the fskit mount to the byte-store subtree is the supported way to
# get a kext-free mount out of a workspace that also holds API resources:
# the guard only inspects mounts under the fskit mount's root prefix.
print("=== part 3: scoping fskit to the byte-store subtree ===\n")
with Workspace({
        "/ram/":
        Mount(RAMResource(), mode=MountMode.WRITE, backend=MountBackend.FSKIT),
        "/gmail/":
        Mount(GmailResource(config=config), mode=MountMode.READ),
}) as ws:
    mp = ws.fuse_mountpoint
    print(f"  /ram/ mounted at {mp} with no kernel extension")
    print("  /gmail/ stays reachable through the mirage command surface:")
    print(f"\n>>> mounted at: {mp}")
    print(">>> Press Enter to unmount and exit...")
    input()
