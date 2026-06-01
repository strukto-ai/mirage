PROMPT = """\
{prefix}
  Remote WebDAV mount (Nextcloud / ownCloud / Hetzner Storage Share).
  Maps WebDAV hierarchy to virtual paths.
  IMPORTANT: This is a remote mount. Prefer targeted reads (grep, head) \
over full scans. Avoid cat on large files without piping to head/tail.
  Supports: ls, cat, head, tail, grep, wc, find, tree, stat, cp, mv, rm, mkdir, touch."""
