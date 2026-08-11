/**
 * An error thrown after the op already ran against the mount.
 *
 * The door reports a successful op to its caller through `IOResult`;
 * this is the same report for an op whose result was withheld. It
 * carries the two fields `IOResult` carries, under the same names, so
 * the fs facade records a withheld op exactly as it records a delivered
 * one instead of guessing from the error class.
 *
 * Extending this is how an error declares "the backend already moved
 * these bytes before I was thrown". That is the opt-in: a door error
 * that does not extend it is one the facade will not record, which is
 * right for a refusal that fired before any I/O.
 *
 * `completed` says the op ran. False is the default because a refusal
 * at a pre gate suppresses the effect, not just the result, and must
 * not be recorded at all.
 *
 * `opSource` names who served it when that was not the owning mount:
 * 'ram' for a warm cache hit or a synthetic namespace answer, neither
 * of which touched the backend. Null means the mount served it.
 *
 * `opBytes` is how many bytes the backend moved before the result was
 * withheld. The caller cannot recover it (the result is gone, and a
 * read's count lives nowhere else), so without it a withheld read
 * records zero and `networkBytes` under-reports real traffic. Null
 * means there is nothing to report beyond the op's own arguments.
 *
 * Mirrors Python's mirage.io.errors.CompletedOpError.
 */
export class CompletedOpError extends Error {
  completed = false
  opSource: string | null = null
  opBytes: number | null = null
}
