# Release plan (MIP2-1405)

How the app gets from this private repository to signed, notarized releases in the public `cc-command-center` repository, without CC Command Center 0.24 picking them up by mistake. Nothing here is run until the maintainer gives the go: no publishing, nothing public, and no Developer ID signing before then. Every release the maintainer or the close users install passes an independent Adversary review first.

## 1. The repository

**Decided (the maintainer, D-025, 2026-10-27): a clean snapshot.** The public `main` starts from one commit of this repository's tree. This repository stays private with its full history.

- **Author:** `Alexander van Rossum <alex@mipyip.com>`, the identity on 0.24's public commits.
- **Left out:** the process documents (`CLAUDE.md`, `BRIEF.md`, `DECISIONS.md`, `CHANGELOG.md`, `.claude/`), the Adversary reports (`.adversary/`), and the tracker tooling (`tools/`: the Linear ledger and the commit hooks that require issue ids).
- **Kept:** the code, tests, `README.md`, `LICENSE` (Apache 2.0, as 0.24), and `docs/`, this plan included.
- **Before it's made:** `test/no-private-names.test.ts` passes, and a scan of the snapshot finds no home paths, private email, client or category names, session ids or tokens. The scan's output is kept with the snapshot's commit id on MIP2-1405.

## 2. Build, sign and notarize

The configuration is in `package.json` under `build`. `npm run package` already makes an ad-hoc-signed arm64 app (MIP2-1404). A release build differs only in these settings:

| Setting | Local (`npm run package`) | Release |
|---|---|---|
| `mac.identity` | `"-"` (ad hoc) | The Developer ID Application certificate, from the Keychain via `CSC_NAME`, given without the `Developer ID Application:` prefix (`Name (TEAMID)`), which electron-builder refuses. It is never stored in the repository |
| `mac.hardenedRuntime` | `false` | `true`, with `build/entitlements.mac.plist`: `allow-jit` and `allow-unsigned-executable-memory` only. Unlike 0.24 there's no `disable-library-validation` (gate run 2, M-3) and no microphone entry, since this app has no dictation (D-008) |
| `mac.notarize` | off | on, through `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` in the environment, as in 0.24 |
| `mac.target` | `dir` | `dmg` and `zip`, arm64. The zip is what the updater downloads |
| `publish` | `null` | the GitHub provider on `cc-command-center`, with channel `ccc` (§3) |
| `electronFuses` | set | the same: RunAsNode, the `NODE_OPTIONS` variable, `--inspect`, and `file://` extra privileges off; cookie encryption, embedded asar integrity validation, and loading the app only from the asar on (gate H-2) |

Every build runs `scripts/check-fuses.mjs` after packaging: it reads the fuse wire from the built binary and fails on any fuse not as `scripts/fuses.mjs` requires. A build that fails the check isn't installed by anyone. The release script, still to be written, runs it too, on the signed build it uploads (gate run 2, I-1).

**Native code and unpacked files** (gate run 2, M-3). Asar integrity covers `app.asar` only, so two things outside it are handled separately. Both are preconditions of the first Developer ID release:
- **node-pty's `pty.node` and `spawn-helper`** load into the main process. They're signed with the app's Developer ID during the signing step, and library validation stays on: the hardened runtime "prevents a program from loading frameworks, plug-ins, or libraries unless they're either signed by Apple or signed with the same Team ID as the main executable" (Apple, Disable Library Validation Entitlement, read 2026-10-27). A replaced `pty.node` then fails to load instead of running in main. The release check confirms with `codesign -dv` that both carry the app's Team ID.
- **The reporter mod's unpacked copy** is hashed at build time (`scripts/mod-hash.mjs`), and the hash is built into `main.cjs`, inside the asar. The app refuses to install a mod that doesn't match it.

**Credentials and dependency code.** `npm ci`, `npm run setup` and `npm run build` run dependency code, so the release script gives them an allowlisted environment without the signing, notarization or GitHub variables. That covers the environment only. Install scripts run as the same user, so credentials kept in the login keychain stay reachable to them: a `gh` login (`gh auth token`) and a notarytool keychain profile (`APPLE_KEYCHAIN_PROFILE`). The dependencies are pinned with integrity hashes in `package-lock.json`, which bounds that residual; it's accepted. electron-builder itself needs the signing and notarization credentials, and gets them; it packages and signs, and doesn't rebuild native modules (`-c.npmRebuild=false`), since `npm run setup` already rebuilt node-pty under the allowlist (pass 13, M-1).

The release script follows 0.24's `scripts/publish.mjs` (electron-builder builds with `--publish never`, then `gh release create` uploads every asset in one step), because electron-builder's own GitHub uploader raced on new releases.

## 3. Updates, and keeping 0.24 away from them

The app uses electron-updater with a **custom channel, `ccc`**. Its releases carry `ccc-mac.yml`, never `latest-mac.yml`. electron-updater names the update file after the channel (`<channel>-mac.yml`, `getChannelFilename` in its providers), and 0.24 reads `latest-mac.yml`. The dry run (§5) confirms the exact file name a `ccc` build writes. Like 0.24, the app downloads nothing until the user chooses to.

Stock electron-updater reads GitHub's "latest" release, which stays on the tombstone, so the app uses its own provider (MIP2-1469, `src/main/update-provider.ts`). It reads `releases.atom` and takes the newest semver tag above its own version whose release carries `ccc-mac.yml`. The app's versions start at **1.0.0**, above every 0.24 tag and the tombstone, so 0.24's releases are never candidates. The release script refuses a version below 1.0.0 or at or below the tombstone.

The order of releases on `cc-command-center`:

1. **The tombstone, 0.24.x** (MIP2-61), built from the 0.24 branch. It is the last release with `latest-mac.yml`. It tells the close users about the move and links to the new app's DMG. It doesn't install anything for them.
2. **The new app's releases**, each with `ccc-mac.yml` only.

**What 0.24 does** (Research, MIP2-1427, memo 8166d18):

- **0.24 never reads `ccc-mac.yml`.** A release without `latest-mac.yml` makes its check fail with nothing on screen, and it doesn't fall back to an older release. So the tombstone has to be the release 0.24 picks, not just the last one with the file.
- **Stable 0.24 builds** take GitHub's "latest" release. Every new-app release is published with `make_latest: false` (`gh release create --latest=false`, also when a draft is published). The release script requires it, and a check refuses a release without it.
- **Beta 0.24 builds** (such as 0.24.2-beta.2) take the newest semver tag in `releases.atom`, whatever its latest or prerelease flag, bare tags and drafts included. So after the tombstone there is a **window** with no newer semver tag of any kind, new-app tags, drafts and CI included, until the close users and the maintainer have the tombstone. Beta users who miss the window update by hand. A pre-publish check refuses any tag newer than the tombstone until the window is closed by hand. Which close users are on beta builds is recorded on MIP2-1137.
- **0.24's changelog:** installed 0.24 builds read `changelog.json` from the public main, so the file at this repository's root is 0.24's, with the farewell release (0.25.0) on top and `critical: true`; without it 0.24 offers "Skip this update" (MIP2-61). The new app doesn't read it.
- **The tombstone build:** `changelog.json` on 0.24's branch stays valid for 0.24, with `critical: true` for the tombstone. It's signed with the same identity as 0.24, and preferably stops checking for updates.

electron-builder 27 also requires signed update manifests (`ELECTRON_BUILDER_UPDATE_SIGN_KEY`); this repository is on 26.17.0, so that applies only after an upgrade.

## 4. The repository flip

With the maintainer's go, in this order:

1. **Electron's `main` becomes `electron-0.24`, its tags kept.** From a clone of `cc-command-center` with `main` at its last commit: `git push origin origin/main:refs/heads/electron-0.24`. Tags aren't touched: they point at commits, not branches, and all 108 stay where they are (`v0.24.2-beta.2`, `electron-final` and the rest). Check with `git ls-remote --tags origin` before and after: the lists match.
2. **The default branch moves to `electron-0.24` for a moment**, in the repository settings, so `main` can be replaced. Any branch protection on `main` is lifted for the next step only.
3. **The snapshot becomes `main`:** `git push --force origin <snapshot commit>:refs/heads/main`, from the snapshot's own repository. Then the default branch goes back to `main`, and the protection back on.
4. **The README and install steps describe the new app** (the snapshot's `README.md`). The legacy pointer to `claude-command-center-releases` (MIP2-1138) stays until no install older than 0.24.0 is left.
5. **The tombstone is published** (§3), from `electron-0.24`, then the window (§3), then the first new-app release with `--latest=false`.

## 5. Dry run

The pipeline is built and dry-run to a **draft** release in a private repository, with an ad-hoc-signed build. This is the "Done when" on MIP2-1405, and it is outward-facing, so it waits for the maintainer's go. Signing with the Developer ID and notarizing come at the first real release.
