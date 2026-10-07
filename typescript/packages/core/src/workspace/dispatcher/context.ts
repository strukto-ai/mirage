import type { IOContext } from '../../context/types.ts'
import type { DispatchFn } from '../../runtime/types.ts'

/** Bind the caller's access facts to its operation door. */
export function bindDispatch(dispatch: DispatchFn, context: IOContext): DispatchFn {
  return (op, path, args, options, report) =>
    dispatch(op, path, args, { _ioContext: context, ...options }, report)
}

/** Mark the redirect paths admitted with this statement. */
export function bindRedirects(dispatch: DispatchFn, targets: readonly string[]): DispatchFn {
  return (op, path, args, options, report) =>
    dispatch(op, path, args, { _judgedTargets: targets, ...options }, report)
}
