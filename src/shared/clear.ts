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
 *
 * A /clear always gives a new sessionId. A return to an id the job had
 * before is Claude Code listing the job under another id for a poll during a
 * restart, then under its own again (QA, MIP2-1570), and isn't reported.
 */
export class ClearWatch {
  private readonly byJob = new Map<string, { sessionId: string; pid: number; ids: Set<string> }>()

  observe(sessions: readonly JobSeen[]): { from: string; to: string }[] {
    const listed = new Set(sessions.map(s => s.sessionId))
    const moved: { from: string; to: string }[] = []
    for (const s of sessions) {
      const before = this.byJob.get(s.shortId)
      if (s.pid === null) continue
      const back = before?.ids.has(s.sessionId) ?? false
      if (before && !back && before.pid === s.pid && before.sessionId !== s.sessionId && !listed.has(before.sessionId)) moved.push({ from: before.sessionId, to: s.sessionId })
      this.byJob.set(s.shortId, { sessionId: s.sessionId, pid: s.pid, ids: (before?.ids ?? new Set()).add(s.sessionId) })
    }
    const jobs = new Set(sessions.map(s => s.shortId))
    for (const id of this.byJob.keys()) if (!jobs.has(id)) this.byJob.delete(id)
    return moved
  }
}
