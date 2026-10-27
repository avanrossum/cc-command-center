// Which process is on the other end of a channel connection (gate M-1,
// MIP2-1430; Research's peer-pid memo). Node has no peer-credential call, so
// the app reads it from `lsof`: our accepted socket is listed with its kernel
// address, and the peer's socket is listed as "->" that address. One
// system-wide listing serves every connection that arrives within a short
// window, since `lsof` costs about 30 ms of CPU however little it lists.

import { execFile } from 'node:child_process'

export interface LsofListing {
  /** Our own Unix sockets: fd → kernel address. */
  ownAddress: Map<string, string>
  /** Peer address ("->0x…") → the pids holding a socket connected to it. */
  holders: Map<string, number[]>
}

/** Parses `lsof -U -F pfdn` (one field per line: p pid, f fd, d device/address, n name). */
export function parseLsof(out: string, selfPid: number): LsofListing {
  const ownAddress = new Map<string, string>()
  const holders = new Map<string, number[]>()
  let pid: number | null = null
  let fd: string | null = null
  for (const line of out.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') (pid = Number(value)), (fd = null)
    else if (tag === 'f') fd = value
    else if (tag === 'd' && pid === selfPid && fd !== null) ownAddress.set(fd, value)
    else if (tag === 'n' && pid !== null && value.startsWith('->')) {
      const list = holders.get(value.slice(2)) ?? []
      if (!list.includes(pid)) list.push(pid)
      holders.set(value.slice(2), list)
    }
  }
  return { ownAddress, holders }
}

const runLsof = (): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile('/usr/sbin/lsof', ['-U', '-F', 'pfdn'], { maxBuffer: 16 * 1024 * 1024, timeout: 5_000 }, (err, stdout) =>
      // lsof exits 1 when some process can't be read; its output is still good.
      err && !stdout ? reject(err) : resolve(stdout),
    ),
  )

/** Lookups that may wait at once; past it a connection is refused at once (pass 4, L-2). */
export const PEER_QUEUE_MAX = 256
/** Lookups one channel may have waiting, so a flood on one channel can't refuse every other channel's mod (pass 5, L-4). */
export const PEER_QUEUE_PER_KEY = 32
/**
 * Lookups each channel may have waiting even when the whole queue is full,
 * so flooding several channels still can't shut out another (pass 6, L-2).
 */
export const PEER_QUEUE_RESERVED = 4

/**
 * Batches peer lookups: one `lsof` per window, however many connections are
 * waiting. Only one listing runs at a time, so a flood that outlasts a slow
 * `lsof` can't stack them up; the next window opens when it's done
 * (pass 4, L-2).
 */
export class PeerResolver {
  private queue: { fd: number; key: string; resolve: (pids: number[]) => void }[] = []
  private readonly waiting = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  /** How many listings have run, for the cost measurement. */
  runs = 0

  constructor(
    private readonly list: () => Promise<string> = runLsof,
    private readonly selfPid: number = process.pid,
    private readonly windowMs = 50,
    private readonly maxQueue = PEER_QUEUE_MAX,
    private readonly maxPerKey = PEER_QUEUE_PER_KEY,
  ) {}

  /** The pids holding the other end of our socket `fd`; empty if none is found, or the queue, or `key`'s share of it, is full. */
  peersOf(fd: number, key = `fd:${fd}`): Promise<number[]> {
    // A caller without a key gets a bucket of its own (pass 6, L-2).
    const mine = this.waiting.get(key) ?? 0
    const full = this.queue.length >= this.maxQueue && mine >= PEER_QUEUE_RESERVED
    if (full || mine >= this.maxPerKey) return Promise.resolve([])
    this.waiting.set(key, mine + 1)
    return new Promise(resolve => {
      this.queue.push({ fd, key, resolve })
      this.schedule()
    })
  }

  private schedule(): void {
    if (this.running || this.timer || !this.queue.length) return
    this.timer = setTimeout(() => void this.flush(), this.windowMs)
  }

  private async flush(): Promise<void> {
    this.timer = null
    this.running = true
    const batch = this.queue
    this.queue = []
    this.runs += 1
    let listing: LsofListing | null = null
    try {
      listing = parseLsof(await this.list(), this.selfPid)
    } catch {
      listing = null
    } finally {
      this.running = false
    }
    for (const { fd, key, resolve } of batch) {
      const left = (this.waiting.get(key) ?? 1) - 1
      if (left > 0) this.waiting.set(key, left)
      else this.waiting.delete(key)
      const addr = listing?.ownAddress.get(String(fd))
      resolve(addr ? (listing!.holders.get(addr) ?? []) : [])
    }
    this.schedule()
  }
}
