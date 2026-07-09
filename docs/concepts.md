# Concepts — the "why" behind the model

Design rationale, not implementation. The "why" that isn't obvious from the code.

## What this is: HITM — Human In The Middle multi-agent orchestration

The organizing principle of the whole product. Named by the user 2026-07-08, the day the
bidirectional bus first ran end to end.

**HITM vs HITL.** Human-In-The-Loop puts the human at the *edge* of an automated pipeline: the
system runs, and the human is a gate that approves, rejects, or waits. Human-In-The-Middle puts
the human at a *node in the mesh* — sitting inside a session, able to message any other session,
be messaged, spawn new ones, and watch the whole bus. Topologically central, not a boundary
checkpoint. The human is a participant in the fleet, not the thing that invokes it.

**The security double-meaning is exact.** A man-in-the-middle on a channel can do three things:
**read** all traffic, **drop or alter** it, and **inject** its own. The features we built around
the awareness bus are precisely those three powers, held deliberately by a human:

- **read** → the ✉ message log: every routing decision, both directions, delivered/held/dropped.
- **drop / alter** → the global kill switch, per-link untrust, the trust gate, the rate guard.
- **inject** → cross-session send, broadcast, spawn-child-with-context, selection→tangent.

These were not a wishlist. A HITM architecture *requires* read/drop/inject, and the design kept
demanding each one until all three existed. The only difference from a plain MITM: the human is
also a working node, not just a tap on the wire.

**What it implies for the control agent.** The fleet conductor is NOT a replacement orchestrator
that takes the fleet off the human's hands. It is a co-pilot for the middle seat — it extends the
human's read/drop/inject reach across more sessions than one person can watch, while the human
stays the middle. This is why the control agent must be fully transparent (viewable activity) and
why the user should be *discouraged* from offloading to it and going quiet: the model breaks the
moment the human leaves the middle. See the roadmap's "Control agent (fleet conductor)".

## Why tangents (tangential-offshoot sessions) exist

The workflow they serve: you're deep in a session, an idea strikes, and you want to
explore it — but you don't want to **stain the current context** and derail what you're
doing. So you need a NEW session, seeded with just enough detail to pick up the idea,
worked in a **separate context**. And crucially, the idea **might not be blocking** — you
don't need to stop and wait on it. You just need to "seed" a session with it and get back
to what you were doing.

That is exactly the split the [hierarchy model](../docs/roadmap.md) encodes:

- **Blocking child** — the parent rolls back to / waits on it. A real dependency: the
  parent's work isn't done until the child's is.
- **Tangential offshoot** — a decoupled side-exploration. The parent keeps going; the
  tangent runs on its own; results (if any) return via a handoff note or the awareness
  bus, **not** by blocking the parent.

The "seed" is the optional **handoff note** passed at spawn time (SpawnComposer): enough
context to start the tangent without dragging the whole transcript along. Same bounded-brief
idea as Phase 10's context extraction — give the offshoot a brief, not the entire history.

Why this matters for the product: without a first-class tangent, an idea mid-flow forces a
bad choice — either derail the current context to chase it, or drop it. The tangent is the
third option: capture it into its own context, keep your place, decide later whether it
mattered.

> Meta (2026-07-08): this entry itself came from a tangent moment — the user had this idea
> while spec'ing a terminal status bar, wanted to capture it without derailing, and noted
> "see? tangents." The concept demonstrating itself.
