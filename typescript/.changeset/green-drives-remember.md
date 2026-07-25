---
'@struktoai/mirage-core': minor
'@struktoai/mirage-node': minor
'@struktoai/mirage-browser': minor
---

Add browser-safe Microsoft Graph backends for OneDrive and SharePoint, plus the Mem0 memory resource.

`find` now walks the synthetic site and library levels of an unscoped SharePoint mount instead of returning nothing, `find -empty` reads a Graph folder's `childCount` instead of treating every folder as non-empty, and a Graph folder's aggregate storage `size` moves from `FileStat.size` to `extra.size_bytes`. A missing Mem0 memory reports `ENOENT`, and a failed redirect target reports `<cmd>: <path>: <strerror>` instead of the internal op-registry message.
