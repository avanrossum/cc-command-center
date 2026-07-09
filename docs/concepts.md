# Concepts — the "why" behind the model

Design rationale, not implementation. The "why" that isn't obvious from the code.

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
