---
name: mirage-filesystem
description: Work with files and directories mounted in a Mirage virtual filesystem. Use when a task mentions Mirage, mounted cloud or database data, Mirage virtual paths, or asks to inspect, search, create, or edit data exposed through the Mirage tools.
---

# Mirage Filesystem

Use the Mirage tools for virtual paths. Host filesystem tools cannot access those paths unless the user separately configured a FUSE mount.

## Workflow

1. Use the Mirage `ls`, `grep`, or `execute_command` tool to discover mounted data.
2. Use the Mirage `read` tool before modifying an existing file.
3. Use `edit` for an existing file and `write` only for a new file.
4. If an edit reports that the file changed since it was read, read the file again, reconsider the edit against the new content, and retry.
5. Use `execute_command` for pipelines and structured-file commands that need Mirage shell semantics.

Do not fall back to a host filesystem tool when a Mirage tool fails on a virtual path. Report the Mirage error or fix the Mirage configuration.
