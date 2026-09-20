/**
 * Public surface of the core package.
 *
 * Everything the CLI and, later, the runtime hooks need is re-exported here so callers
 * never reach into a subdirectory.
 */

export { parseFrontmatter } from "./catalog/frontmatter.js";
export type { ScanOptions } from "./catalog/scan.js";
// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
export { catalogFingerprint, findProjectRoot, scanCatalog } from "./catalog/scan.js";
export { parseMcpServersFromToml } from "./catalog/toml.js";
export type {
  Catalog,
  CatalogEntry,
  CatalogKind,
  CatalogRuntime,
  CatalogScope,
  CatalogSource,
  ScanContext,
} from "./catalog/types.js";
export {
  CATALOG_KINDS,
  CATALOG_RUNTIMES,
  CATALOG_SCOPES,
  catalogId,
  normaliseDescription,
  normaliseName,
} from "./catalog/types.js";
export type {
  ConfigSource,
  ResolveConfigInput,
  ResolvedConfig,
  SkillfulConfig,
} from "./config/resolve.js";
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export { defaultConfigPath, resolveConfig } from "./config/resolve.js";
export type {
  InstalledCliCommand,
  InstalledCliDiscoveryResult,
} from "./discovery/installed-cli.js";
export { discoverInstalledCliCommands, flattenCarapaceExport } from "./discovery/installed-cli.js";
export type { RefreshCapabilitiesOptions, RefreshReport } from "./discovery/refresh.js";
// ---------------------------------------------------------------------------
// Capability discovery cache
// ---------------------------------------------------------------------------
export { refreshCapabilities } from "./discovery/refresh.js";
export type { CorpusSnapshot } from "./eval/corpus.js";
export {
  hasInfrastructureIdentifier,
  isPublicSafe,
  loadCorpus,
  PRIVATE_MARKERS,
  redactInfrastructure,
  sanitiseCorpus,
  saveCorpus,
} from "./eval/corpus.js";
export type { Fixture, FixtureGroup, ResolvedFixture } from "./eval/fixtures.js";
// ---------------------------------------------------------------------------
// Eval
// ---------------------------------------------------------------------------
export {
  ABSTAIN,
  buildGoldIndex,
  FIXTURE_GROUPS,
  FixtureError,
  groupCounts,
  parseFixtures,
  resolveFixtures,
} from "./eval/fixtures.js";
export type { DecisionMetrics } from "./eval/metrics/decision.js";
export {
  abstained,
  chosenId,
  decisionMetrics,
  decisionMetricsByGroup,
  decisionSignature,
} from "./eval/metrics/decision.js";
export type { LatencyMetrics } from "./eval/metrics/latency.js";
export { latencyMetrics, percentile } from "./eval/metrics/latency.js";
export type { FixtureOutcome, KindRetrieval, RetrievalMetrics } from "./eval/metrics/retrieval.js";
export { retrievalMetrics, retrievalMetricsByKind } from "./eval/metrics/retrieval.js";
export type { FixtureStability, StabilityMetrics } from "./eval/metrics/stability.js";
export { stabilityMetrics } from "./eval/metrics/stability.js";
export type { GateCheck, GateCriteria, GateResult, ReportProvenance } from "./eval/report.js";
export { DEFAULT_GATE, evaluateGate, renderGateText, renderMarkdown } from "./eval/report.js";
export type { EvalConfig, EvalOptions, EvalReport, RouteCaller } from "./eval/run.js";
export { fixtureGroupsOf, runEval } from "./eval/run.js";
export type { SweepGrid, SweepOptions, SweepPoint } from "./eval/sweep.js";
export {
  DEFAULT_SWEEP_GRID,
  quotaGroupsWithSkillLimit,
  renderSweep,
  runSweep,
} from "./eval/sweep.js";
export type { CachedRoute, CacheStore } from "./hooks/cache.js";
export {
  CACHE_VERSION,
  cacheGet,
  cacheSet,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  emptyCache,
  loadCache,
  normalisePrompt,
  pruneCache,
  routeCacheKey,
  saveCache,
} from "./hooks/cache.js";
export {
  DEGRADED_REMINDER,
  degradedReminder,
  describeDegraded,
  isBenignSkip,
} from "./hooks/degrade.js";
export type { DetectedRuntime, RuntimeLocation } from "./hooks/detect.js";
// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
export { detectRuntimes, presentRuntimes, runtimeLocations } from "./hooks/detect.js";
export type { HookStatus, InstallSummary, UninstallSummary } from "./hooks/install.js";
export {
  buildInstallContext,
  hookStatus,
  installHooks,
  uninstallHooks,
} from "./hooks/install.js";
export { installClaudeCode, uninstallClaudeCode } from "./hooks/installers/claude-code.js";
export { installCodex, uninstallCodex } from "./hooks/installers/codex.js";
export { extensionSource } from "./hooks/installers/extension-source.js";
export { installOmp, uninstallOmp } from "./hooks/installers/omp.js";
export { installPi, uninstallPi } from "./hooks/installers/pi.js";
export type { InstallContext, InstallOutcome, UninstallOutcome } from "./hooks/installers/types.js";
export type { HookCommand, HookEntry, JsonReadResult } from "./hooks/json-merge.js";
export {
  backupFile,
  ensureDir,
  isSkillfulCommand,
  isSkillfulEntry,
  readJsonFile,
  removeSkillfulEntries,
  SKILLFUL_HOOK_MARKER,
  upsertSkillfulEntry,
  writeJsonAtomic,
} from "./hooks/json-merge.js";
export type { RenderOptions } from "./hooks/render.js";
export {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_RUNNERS_UP,
  INJECTION_PREFIX,
  renderInjection,
} from "./hooks/render.js";
export type { HookDeps, HookInput, HookOutcome, HookPayload } from "./hooks/runner.js";
export { DISABLE_ENV, injectionPayload, isDisabled, runHook } from "./hooks/runner.js";
export type { JevClientOptions, JevErrorCode, JevTarget } from "./jev/client.js";
// ---------------------------------------------------------------------------
// Jev client
// ---------------------------------------------------------------------------
export {
  callSystemOne,
  JevError,
  resolveApiKey,
  resolveJevDefaults,
  resolveJevTarget,
} from "./jev/client.js";
export type {
  Answer,
  ChoiceAnswer,
  ChoiceQuestion,
  NoulAnswer,
  NoulQuestion,
  Question,
  JevProvider,
  JevProviderDefinition,
  SystemOneRequest,
  SystemOneResponse,
} from "./jev/types.js";
export {
  API_KEY_ENV,
  autoJevProvider,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  isJevProvider,
  isChoiceAnswer,
  isNoulAnswer,
  JEV_PROVIDERS,
  JEV_PROVIDER_ORDER,
  PROVIDER_ENV,
} from "./jev/types.js";
export type { RedactOptions } from "./redact.js";
// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------
export { redactedEnvNames, redactText, redactValue } from "./redact.js";
export type { Bm25Doc, Bm25Options, ScoredDoc } from "./retrieval/bm25.js";
export { rankBm25 } from "./retrieval/bm25.js";
export type {
  QuotaGroup,
  Shortlist,
  ShortlistEntry,
  ShortlistGroupResult,
  ShortlistOptions,
} from "./retrieval/shortlist.js";
export {
  buildShortlist,
  DEFAULT_QUOTA_GROUPS,
  DEFAULT_SHORTLIST_SIZE,
} from "./retrieval/shortlist.js";
// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------
export { tokenize } from "./retrieval/tokenize.js";
export type { BuiltRequest, Candidate, RouteState } from "./router/questions.js";
export {
  buildRouteRequest,
  buildRouteState,
  NONE_OPTION,
  PRIMARY_QUESTION_ID,
  toCandidate,
} from "./router/questions.js";
export type {
  DegradedReason,
  RouteDecision,
  RouteOptions,
  RoutePick,
  RouteRankedPick,
  RouteResult,
  SkipReason,
} from "./router/route.js";
// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export { route } from "./router/route.js";
export type {
  PromptHeuristicResult,
  RouteThresholds,
  SkipReason as PromptSkipReason,
} from "./router/thresholds.js";
export {
  DEFAULT_THRESHOLDS,
  evaluatePromptHeuristics,
  truncatePrompt,
} from "./router/thresholds.js";
export type {
  AdoptionStats,
  CandidateStat,
  OperationalStats,
  OverviewStats,
  TelemetrySummary,
} from "./telemetry/aggregate.js";
export { ACCEPTANCE_WINDOW_MS, matchUsage, summarise } from "./telemetry/aggregate.js";
export {
  barChart,
  confusionTable,
  escapeHtml,
  formatNumber,
  formatRate,
  histogram,
  latencyBuckets,
} from "./telemetry/charts.js";
export type { BenchOutcome, DashboardInput } from "./telemetry/dashboard.js";
export { loadBenchOutcome, redactReport, renderDashboard } from "./telemetry/dashboard.js";
export type {
  CapabilityUsedEvent,
  RankingEntry,
  RouteEvent,
  TelemetryEvent,
  UsageSource,
} from "./telemetry/events.js";
export {
  isTelemetryEvent,
  MAX_CANDIDATE_IDS,
  MAX_LINE_BYTES,
  MAX_RANKING_ENTRIES,
  ROUTE_DECISIONS,
  SCHEMA_VERSION,
  USAGE_SOURCES,
} from "./telemetry/events.js";
export type { PathContext } from "./telemetry/paths.js";
export {
  APP_DIR_NAME,
  defaultReportPath,
  EVENTS_FILE_NAME,
  eventsPath,
  rotatedEventsPath,
  stateDir,
} from "./telemetry/paths.js";
export type { ReadOptions, ReadResult } from "./telemetry/reader.js";
export { readEvents, routeEvents, usageEvents } from "./telemetry/reader.js";
export type { RetentionOptions, RetentionResult } from "./telemetry/retention.js";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ROTATED,
  DEFAULT_RETENTION_DAYS,
  MAINTENANCE_INTERVAL,
  maintain,
  rotatedPaths,
} from "./telemetry/retention.js";
export type { WriteOptions } from "./telemetry/writer.js";
// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------
export {
  buildCapabilityUsedEvent,
  buildRouteEvent,
  isTelemetryDisabled,
  logSize,
  TELEMETRY_DISABLE_ENV,
  writeEvent,
} from "./telemetry/writer.js";
