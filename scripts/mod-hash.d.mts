// Types for scripts/mod-hash.mjs, which the app imports too (gate run 3, L-8).

/** The reporter mod's hash: the one algorithm the build and the app share. "refused: …" for a folder holding a symlink or a NUL byte. */
export function modHashOf(dir: string): string
