/** Convert function-relative line to file-absolute line when start_line is known. */
export function toFileLine(startLine: number, issueLine: number): number {
  if (startLine > 0 && issueLine > 0) return startLine + issueLine - 1
  return issueLine
}
