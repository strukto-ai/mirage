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
import subprocess

from dotenv import load_dotenv

from mirage import Mount, MountMode, Workspace
from mirage.resource.slack import SlackConfig, SlackResource

load_dotenv(".env.development")

config = SlackConfig(
    token=os.environ["SLACK_BOT_TOKEN"],
    search_token=os.environ.get("SLACK_USER_TOKEN"),
)

# Part 1: Slack cannot be served over fskit, and mirage says so at mount
# time instead of serving empty files.
#
# chat.jsonl is rendered from the Slack API on read, so its size is
# unknowable until the bytes exist. Over FUSE that is fine: direct_io makes
# the kernel read to EOF regardless of the reported size. FSKit has no
# direct_io, so it would issue zero reads against a 0-byte stat and every
# conversation would come back empty with exit code 0. A refused mount is
# better than silent data loss.
print("=== part 1: fskit refuses a size-unknown resource ===\n")
try:
    with Workspace({
            "/slack/":
            Mount(SlackResource(config=config),
                  mode=MountMode.READ,
                  fuse=True,
                  fuse_backend="fskit")
    }):
        print("  unexpectedly mounted")
except RuntimeError as err:
    print(f"  refused as designed:\n  {err}\n")

# Part 2: the same resource over the default FUSE backend, where the
# hydrate-on-open recipe makes size-unknown files read correctly.
print("=== part 2: the same mount over backend='fuse' ===\n")
with Workspace({
        "/slack/":
        Mount(SlackResource(config=config), mode=MountMode.READ, fuse=True)
}) as ws:
    mp = ws.fuse_mountpoint
    print(f"mounted at {mp}\n")

    channels = os.listdir(f"{mp}/channels")
    ch = next((c for c in channels if "general" in c), channels[0])
    dates = os.listdir(f"{mp}/channels/{ch}")

    for d in reversed(dates):
        path = f"{mp}/channels/{ch}/{d}/chat.jsonl"
        if not os.path.exists(path):
            continue
        # This is the exact sequence fskit cannot serve: stat reports 0
        # before the file is opened, and only direct_io keeps the read
        # correct anyway.
        print(f"--- size-unknown semantics on {d}/chat.jsonl ---")
        print(f"  stat before open: {os.stat(path).st_size} bytes")
        with open(path) as f:
            text = f.read().strip()
        wc = subprocess.run(["wc", "-lc", path],
                            capture_output=True,
                            text=True)
        n_lines, n_bytes = wc.stdout.split()[:2]
        print(f"  wc -lc          : {n_lines} messages, {n_bytes} bytes")
        print(f"  stat after read : {os.stat(path).st_size} bytes")
        print(f"  bytes actually read: {len(text)}")
        break

    print(f"\n>>> mounted at: {mp}")
    print(">>> Press Enter to unmount and exit...")
    input()
