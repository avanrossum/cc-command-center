// Types for scripts/release-lib.mjs, for its tests.
export function parseVersion(tag: string): [number, number, number, string | null] | null
export function newerThan(a: string, b: string): boolean
export function windowRefusal(tag: string, window: { tombstone: string | null; closed: boolean } | null): string | null
export function releaseArgs(o: { tag: string; repo: string; title: string; notesFile: string; files: string[]; draft: boolean; target?: string | null; prerelease?: boolean }): string[]
export function latestFalseRefusal(args: string[]): string | null
export function updateFileRefusal(files: string[]): string | null
export function modPackRefusal(built: string, packaged: string): string | null
export function teamOf(codesignOutput: string): string | null
export function teamRefusal(appTeam: string | null, binaries: { path: string; team: string | null }[], adhoc: boolean): string | null
export const FIRST_VERSION: string
export function versionRefusal(tag: string, tombstone: string | null): string | null
export function updateConfigRefusal(text: string | null): string | null
export function assetRefusal(names: string[], version: string): string | null
export function identityRefusal(name: string): string | null
export const APP_ID: string
export function bundleIdRefusal(id: string): string | null
export function testFeedRefusal(asarText: string): string | null
export function untrackedRefusal(porcelain: string): string | null
export function branchRefusal(branch: string): string | null
export function targetRefusal(o: { target: string | null; mainSha: string | null; targetTree: string | null; expectedTree: string }): string | null
export function remoteTagRefusal(refs: { ref: string; object?: { sha: string; type: string } }[], tag: string, target: string): string | null
export function builderConfig(o: { identity: string | null; adhoc: boolean; repo: string | null }): string[]
export const PUBLIC_REPO: string
export function installEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
export function comparePrerelease(a: string, b: string): number
export function prereleaseRefusal(version: string, prerelease: boolean): string | null
