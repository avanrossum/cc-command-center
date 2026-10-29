// The coupling package's public surface. The app's main process imports from
// here; the renderer imports only @ccc/contract.

export {
  claudeEnv,
  ClaudeCommandError,
  createClaudeExitCode,
  createClaudeRunner,
  createClaudeSpawner,
  resolveClaudeBinary,
  awaitLoginPath,
  resolveLoginPath,
  sessionEnv,
  SESSION_SWITCHES,
  setLoginPath,
  type ClaudeExitCode,
  type ClaudeRunner,
  type ClaudeSpawner,
} from './claude-cli.ts'
export { CHANNEL_SOCKETS, memoryStore, MOD_RELOAD, MOD_INTEGRITY, parseVersion, SelfCheck, type ChannelHealth, type SelfCheckStore } from './self-check.ts'
export { hostedSessions, SupervisorWatchdog, type WatchdogOptions, type WatchdogState } from './watchdog.ts'
export { ASK_GRACE_MS, FleetPoller, livePending, MOD_SILENCE_MS, type FleetListener, type FleetPollerOptions } from './fleet-poller.ts'
export { DEFAULT_USAGE_DIR, readUsageDir } from './usage-files.ts'
export { parseUsageReport, UsageReportReader, USAGE_REPORT_ARGS, type UsageCredits, type UsageReport, type UsageRow } from './usage-report.ts'
export {
  parseEnvelope,
  parseReporterFile,
  removeLegacyReporterDir,
  reporterFields,
  type ReporterFields,
  type ReporterRead,
} from './reporter.ts'
export { PeerResolver } from './channel/peer.ts'
export { ChannelHub, DEFAULT_CHANNEL_ROOT, memoryReplyKeys, type ReplyKeys, type AnswerInput, type ChannelHubOptions, type ChannelLaunch, type PromptStatus } from './channel/hub.ts'
export { validateReporterFile, type Validated } from './reporter-schema.ts'
export {
  NotBuiltYet,
  type AttachCommand,
  type LaunchOptions,
  type ListResult,
  type ResumeOptions,
  type SessionHost,
} from './session-host.ts'
export {
  backgroundedId,
  ResumedAsCopy,
  StraySessions,
  SupervisorHost,
  trustRefusal,
  WorkspaceNotTrusted,
  type HostChannels,
  type PreparedLaunch,
  type SupervisorHostOptions,
} from './supervisor-host.ts'
export { TrustRuns, type TrustEvents } from './trust-run.ts'
export { SessionControl, type SessionControlOptions } from './session-control.ts'
export { AttachPool, bracketedPaste, KEPT_ATTACHED, quotePath, spawnAttach, type AttachEvents, type AttachProcess, type SpawnAttach } from './attach-view.ts'
export { clearUserFlags } from './file-flags.ts'
export { CommandLog, COMMAND_LOG_MAX_BYTES, COMMAND_LOG_STREAM_BYTES, redactArgs, type CommandEntry } from './command-log.ts'
export { checkSupervisorPath, daemonPid, processPathOk, processStartedAt, pathFromPs, sharedSupervisorStart, supervisorState, type SupervisorPath } from './supervisor-env.ts'
export { terminalHostOf, terminalName } from './process-host.ts'
export { claudeConfigDir, readSavedOptions, readStateFile, STATE_MAX_BYTES, type SavedOptions } from './job-state.ts'
