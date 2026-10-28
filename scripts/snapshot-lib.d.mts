// Types for scripts/snapshot-lib.mjs, for its tests.
export function parseExcludes(text: string): string[]
export function readExcludes(root: string): string[]
export function snapshotTree(root: string, rev: string, excludes: string[]): string
export function readPublished(root: string): string[]
export function unclassified(root: string, rev: string, excludes: string[], published: string[]): string[]
export function addedToConfirm(nameStatus: string): string[]
