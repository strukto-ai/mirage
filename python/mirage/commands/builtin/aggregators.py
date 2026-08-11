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


async def concat_aggregate(results: list[tuple[str, bytes]]) -> bytes:
    return b"".join(data for _, data in results)


async def header_aggregate(results: list[tuple[str, bytes]]) -> bytes:
    chunks: list[bytes] = []
    for i, (path, data) in enumerate(results):
        if len(results) > 1:
            header = f"==> {path} <==\n"
            if i > 0:
                header = "\n" + header
            chunks.append(header.encode())
        chunks.append(data)
    return b"".join(chunks)


async def prefix_aggregate(results: list[tuple[str, bytes]]) -> bytes:
    lines: list[str] = []
    for path, data in results:
        if not data:
            continue
        for line in data.decode(errors="replace").rstrip("\n").split("\n"):
            if len(results) > 1:
                lines.append(f"{path}:{line}")
            else:
                lines.append(line)
    if not lines:
        return b""
    return ("\n".join(lines) + "\n").encode()


async def wc_aggregate(results: list[tuple[str, bytes]]) -> bytes:
    rows: list[tuple[list[int], str]] = []
    totals: list[int] = []
    for path, data in results:
        text = data.decode(errors="replace").strip()
        if not text:
            continue
        counts: list[int] = []
        for token in text.split():
            if not (token.isascii() and token.isdigit()):
                break
            counts.append(int(token))
        if not counts:
            continue
        rows.append((counts, path))
        if not totals:
            totals = [0] * len(counts)
        for idx, n in enumerate(counts):
            if idx < len(totals):
                totals[idx] += n
    if len(results) > 1 and totals:
        rows.append((totals, "total"))
    if not rows:
        return b""
    # GNU wc layout: counts right-aligned to a shared width, space-separated;
    # a single count for a single row prints unpadded.
    if len(rows) == 1 and len(rows[0][0]) == 1:
        nums, label = rows[0]
        return f"{nums[0]} {label}\n".encode()
    width = max(len(str(n)) for nums, _ in rows for n in nums)
    lines = [
        " ".join(str(n).rjust(width) for n in nums) + f" {label}"
        for nums, label in rows
    ]
    return ("\n".join(lines) + "\n").encode()
