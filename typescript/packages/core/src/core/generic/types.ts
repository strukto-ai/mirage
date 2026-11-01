/** find's row actions: -print, -print0, -ls and -delete. */
export type RowActionKind = 'print' | 'print0' | 'ls' | 'delete'

/** The one-letter kind a -printf %y/%Y directive renders. */
export type PrintfKind = 'f' | 'd' | 'l' | 'c' | 'p'

export interface FindEntry {
  key: string
  name: string
  // 'l' is a namespace symlink: GNU find without -L reports the link
  // itself and never walks through it, so it is never 'f' or 'd'.
  kind: 'f' | 'd' | 'l' | 'c' | 'p'
  depth: number
  isEmpty?: boolean | null
  mtime?: number | null
}

export type ActionKind = RowActionKind | 'exec' | 'printf'

// `-mtime`, `-newermt` and a resolved `-newer`: an inclusive epoch-second
// window over the entry's modification time. The same bounds fold into the
// expression's flat window (`FindExpr.mtimeMin`/`mtimeMax`), which is what a
// backend pushes down and the generic post-filters with, so an entry whose
// mtime the walk did not fetch passes here and meets the window afterwards.
// The node's own job is its position: a `-prune` after it fires only for a
// directory the test holds for, and one before it fires regardless, as GNU
// orders them. A prune reached past an undecided test is recorded as
// pending for the caller to settle once it has statted the directory.
export interface Mtime {
  op: 'mtime'
  lo: number | null
  hi: number | null
}

// A directory whose `-prune` decision waited on time tests the walk could
// not decide: a prune reached past one, or every prune skipped on the
// strength of one (`-mtime 1 -o -prune`). The entry is kept whole: whether
// the prune stands is settled by evaluating the expression again with the
// directory's mtime, since a failing test may send GNU down another arm
// that prunes anyway (`( -mtime 1 -o -type d ) -prune`).
export interface PendingPrune {
  entry: FindEntry
}

export interface Name {
  op: 'name'
  pattern: string
  icase: boolean
}

export interface Path {
  op: 'path'
  pattern: string
  prefix?: string
  root?: string
  raw?: string
}

export interface Type {
  op: 'type'
  kind: string
}

export interface Empty {
  op: 'empty'
}

export interface Not {
  op: 'not'
  kid: PredNode
}

export interface And {
  op: 'and'
  kids: PredNode[]
}

export interface Or {
  op: 'or'
  kids: PredNode[]
}

export interface TrueNode {
  op: 'true'
}

export interface Action {
  op: 'action'
  kind: ActionKind
  batch?: boolean
}

export interface Prune {
  op: 'prune'
  pruned: string[]
  pending: PendingPrune[]
}

export type PredNode =
  | Name
  | Path
  | Type
  | Empty
  | Not
  | And
  | Or
  | TrueNode
  | Action
  | Prune
  | Mtime

// What evaluating an expression on one entry did besides answer: whether an
// action was reached, whether a prune node recorded the entry (firm or
// pending), and the time tests the entry carried no mtime for on the path
// that decided the answer so far; a branch whose outcome they could not
// have changed drops them again.
export interface Effects {
  acted: boolean
  pruned: boolean
  deferred: Mtime[]
}

export interface EmitStartPathOptions {
  kind: FindEntry['kind']
  isEmpty?: boolean | null
  exists: boolean
  tree: PredNode
  maxDepth: number | null | undefined
  minDepth: number | null | undefined
  size?: number | null | undefined
  minSize?: number | null | undefined
  maxSize?: number | null | undefined
}

export interface BuildTreeOptions {
  name?: string | null | undefined
  iname?: string | null | undefined
  pathPattern?: string | null | undefined
  type?: string | null | undefined
  nameExclude?: string | null | undefined
  orNames?: string[] | null | undefined
  empty?: boolean | null | undefined
}
