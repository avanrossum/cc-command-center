// A /clear in a background session (MIP2-1557, Research MIP2-1556): Claude
// Code keeps the job (short id) and its process (pid) and gives it a new
// sessionId. The old id leaves \`agents --json\`; the new one appears on the
// same row. Pure, so main decides from it and tests run it directly.

export interface JobSeen {
  sessionId: string
  shortId: string
  pid: number | null
}

/**
 * The sessions whose id changed under the same job and process since the
 * last poll: same short id, same pid, a new sessionId, and the old one no
 * longer listed. Main then checks the mod said so too before moving
 * anything.
 */
export class ClearWatch {
  private readonly byJob = new Map<string, { sessionId: string; pid: number }>()

  observe(sessions: readonly JobSeen[]): { from: string; to: string }[] {
    const listed = new Set(sessions.map(s => s.sessionId))
    const moved: { from: string; to: string }[] = []
    for (const s of sessions) {
      const before = this.byJob.get(s.shortId)
      if (s.pid === null) continue
      if (before && before.pid === s.pid && before.sessionId !== s.sessionId && !listed.has(before.sessionId)) moved.push({ from: before.sessionId, to: s.sessionId })
      this.byJob.set(s.shortId, { sessionId: s.sessionId, pid: s.pid })
    }
    const jobs = new Set(sessions.map(s => s.shortId))
    for (const id of this.byJob.keys()) if (!jobs.has(id)) this.byJob.delete(id)
    return moved
  }
}
