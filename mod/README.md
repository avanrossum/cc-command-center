# ccc-reporter

CC Command Center's reporter mod. It runs inside a Claude Code session and gathers that session's state: model, effort, context, usage, subagents, tool calls, peer messages and files written. It sends that state to the app over the session's authenticated channel. It also offers permission and single-choice question prompts to the app, and submits prompts the app relays. Every hook passes its event on unchanged, except a prompt the app answers; the mod then builds the decision itself (`hooks/channel-wire.ts`).

The app loads it only on sessions it launches, with `claude --bg --plugin-dir <this folder> --settings <file>`. It isn't installed user-wide, and nothing changes `~/.claude/settings.json`.

Its options come from `pluginConfigs["ccc-reporter@inline"]` in the session's 0600 `--settings` file: `socketPath`, `secret` and `channelRoot`. Without them it sends nothing.

It writes one file: `~/.claude/ccc/usage/<sessionId>.json`, the rate-limit windows in the statusLine shape that `~/.claude/hooks/usage-governor.sh` reads.

It has function hooks only. A command hook would get the plugin's options, the secret included, in its environment.

To check it: `claude plugin validate mod`. Once a session has loaded it, the engine lays its types in `mod/.claude-plugin/types/` (gitignored), and `npm run typecheck:mod` typechecks it against them.
