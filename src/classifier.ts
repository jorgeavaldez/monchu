/**
 * Deliberately disabled until a classifier provider/key is configured.
 * This is the admission seam, not a fallback router or permission check.
 */
export function classifyInput(_message: string): { status: "disabled" } {
  return { status: "disabled" };
}
