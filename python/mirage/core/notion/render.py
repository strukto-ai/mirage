from typing import Any

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


def _rich_text_to_md(rich_text_list: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for rt in rich_text_list:
        text = rt.get("plain_text", "")
        annotations = rt.get("annotations", {})
        if annotations.get("code"):
            text = f"`{text}`"
        if annotations.get("bold"):
            text = f"**{text}**"
        if annotations.get("italic"):
            text = f"*{text}*"
        if annotations.get("strikethrough"):
            text = f"~~{text}~~"
        href = rt.get("href")
        if href:
            text = f"[{text}]({href})"
        parts.append(text)
    return "".join(parts)


def _block_to_md(block: dict[str, Any], indent: int = 0) -> str:
    btype = block.get("type", "")
    content = block.get(btype, {})
    rich_text = content.get("rich_text", [])
    text = _rich_text_to_md(rich_text)
    prefix = "  " * indent

    if btype == "paragraph":
        return f"{prefix}{text}"
    if btype in ("heading_1", "heading_2", "heading_3"):
        level = int(btype[-1])
        return f"{'#' * level} {text}"
    if btype == "bulleted_list_item":
        return f"{prefix}- {text}"
    if btype == "numbered_list_item":
        return f"{prefix}1. {text}"
    if btype == "to_do":
        checked = content.get("checked", False)
        marker = "x" if checked else " "
        return f"{prefix}- [{marker}] {text}"
    if btype == "toggle":
        return f"{prefix}<details><summary>{text}</summary></details>"
    if btype == "code":
        language = content.get("language", "")
        return f"```{language}\n{text}\n```"
    if btype == "quote":
        return f"{prefix}> {text}"
    if btype == "callout":
        icon = content.get("icon", {})
        emoji = icon.get("emoji", "") if icon.get("type") == "emoji" else ""
        return f"{prefix}> {emoji} {text}"
    if btype == "divider":
        return "---"
    if btype == "image":
        img = content.get(content.get("type", ""), {})
        url = img.get("url", "")
        caption = _rich_text_to_md(content.get("caption", []))
        return f"![{caption}]({url})"
    if btype == "bookmark":
        url = content.get("url", "")
        caption = _rich_text_to_md(content.get("caption", []))
        return f"[{caption or url}]({url})"
    if btype == "equation":
        return f"$${content.get('expression', '')}$$"
    if btype == "table_of_contents":
        return "[TOC]"
    if btype in ("child_page", "child_database"):
        return ""
    return f"{prefix}{text}" if text else ""


def _walk_block(block: dict[str, Any], indent: int, lines: list[str]) -> None:
    line = _block_to_md(block, indent)
    if line or block.get("type") == "paragraph":
        lines.append(line)
    for child in block.get("children", []):
        _walk_block(child, indent + 1, lines)


def blocks_to_markdown(blocks: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for block in blocks:
        _walk_block(block, 0, lines)
    return "\n\n".join(lines) + "\n" if lines else ""
