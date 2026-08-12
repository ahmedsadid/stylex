/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

export { VERSION } from './version';

export {
  TEST_ASSUMPTION_PROTOCOL_VERSION,
  createTestAssumption,
  validateTestAssumption,
} from './assumption/model';
export type {
  TestAssumption,
  TestAssumptionDefinition,
  TestAssumptionFact,
  TestAssumptionFactStatus,
  TestAssumptionInput,
} from './assumption/model';
export {
  assertCurrentTestAssumption,
  loadTestAssumption,
  loadTestAssumptionByArtifactHash,
  persistTestAssumption,
} from './assumption/records';

export {
  BOOTSTRAP_DISCOVERY_PROTOCOL_VERSION,
  inspectBootstrap,
} from './bootstrap/discover';
export type {
  BootstrapInspection,
  BootstrapPackageInspection,
  BuildIntegrationInspection,
  BuildIntegrationKind,
  PackageManagerInspection,
  PackageManagerName,
} from './bootstrap/discover';
export {
  BOOTSTRAP_WIRING_LIMITATION,
  BOOTSTRAP_WIRING_MODEL,
  inspectBootstrapCandidate,
} from './bootstrap/guard';
export type { BootstrapGuardResult } from './bootstrap/guard';
export {
  BOOTSTRAP_TASK_PROTOCOL_VERSION,
  openBootstrapTask,
} from './bootstrap/task';
export {
  RSPACK_SENTINEL_CHECK_VERSION,
  RSPACK_SENTINEL_LIMITATION,
  bootstrapRspackProviderId,
  runBootstrapRspackProvider,
} from './bootstrap/provider';

export {
  RECORD_COLLECTIONS,
  STATE_DIRECTORY,
  STATE_SCHEMA_VERSION,
  initializeProject,
  openProject,
  projectDirectories,
  readArtifact,
  readConfig,
  readRecord,
  readSchemaVersion,
  writeArtifact,
  writeConfig,
  writeRecord,
} from './state/project';
export type {
  ArtifactReference,
  ProjectConfig,
  ProjectConfigInput,
  ProjectState,
  RecordEnvelope,
} from './state/project';

export {
  DEFAULT_EVIDENCE_CONFIG,
  normalizeEvidenceConfig,
} from './evidence/config';
export {
  previewEvidenceOutput,
  repositoryEvidenceIdentity,
  runCommandProvider,
} from './evidence/command';
export type {
  CommandExecution,
  CommandExecutionContext,
  CommandCacheLookup,
  CommandCacheProbe,
  CommandRecord,
  PlatformFingerprint,
  RepositoryEvidenceResult,
} from './evidence/command';
export {
  evidenceCacheKey,
  loadCachedExecution,
  saveCachedExecution,
} from './evidence/cache';
export type { EvidenceCacheInputs } from './evidence/cache';
export {
  createEvidenceSchedule,
  evidenceScheduleIdentity,
  runEvidenceSchedule,
} from './evidence/scheduler';
export type {
  EvidenceRunEntry,
  EvidenceSchedule,
  EvidenceScheduleItem,
  EvidenceScheduleResult,
} from './evidence/scheduler';
export { aggregateRepositoryCoverage } from './evidence/coverage';
export type {
  CoverageEntry,
  CoverageStatus,
  CoverageSummary,
} from './evidence/coverage';
export {
  loadVerificationCandidate,
  loadVerificationCandidates,
  saveVerificationCandidate,
} from './evidence/candidates';
export type { VerificationCandidate } from './evidence/candidates';
export { createVerificationWorkspace } from './evidence/workspace';
export {
  createRepositoryEvidenceBundle,
  evidenceBundleLimitationsHash,
  loadLatestRepositoryEvidenceBundle,
  loadRepositoryEvidenceBundle,
  saveRepositoryEvidenceBundle,
  validateRepositoryEvidenceBundle,
} from './evidence/bundle';
export type {
  BundleRepositoryEntry,
  BundleStaticEntry,
  RepositoryEvidenceBundle,
} from './evidence/bundle';
export {
  evaluateRepositoryEvidence,
  loadLatestRepositoryEvidenceVerdict,
  loadRepositoryEvidenceVerdict,
  saveRepositoryEvidenceVerdict,
} from './evidence/verdict';
export { verifyPersistedCandidates } from './evidence/verify';
export type { VerificationResult } from './evidence/verify';
export type {
  ClaimRecord,
  RepositoryEvidenceVerdict,
  VerdictOutcome,
} from './evidence/verdict';
export { createEvidenceProviderRegistry } from './evidence/registry';
export type {
  EvidenceProviderRegistry,
  EvidenceProviderRunner,
} from './evidence/registry';
export type {
  BootstrapRspackProviderConfig,
  CommandProviderConfig,
  EvidenceConfig,
  EvidenceCost,
  EvidenceProviderConfig,
  GeneratedRuntimeProbeProviderConfig,
  EvidenceSubjectKind,
  RepositoryCheck,
  RuntimeCheck,
  RuntimeCommandProviderConfig,
  RuntimeInterface,
} from './evidence/config';

export { appendStateEvent, rebuildIndexes, replayEvents } from './state/events';
export type {
  EntityKind,
  IndexEntry,
  ReplayResult,
  StateEvent,
  StateIndexes,
} from './state/events';

export { cleanupProject, migrateProject } from './state/maintenance';
export type { CleanupResult, MigrationResult } from './state/maintenance';

export { canonicalJson, immutableJson, parseJson } from './state/json';
export type { JsonValue } from './state/json';

export {
  RUNTIME_PROTOCOL_VERSION,
  compareRuntimeReports,
  normalizeRuntimeCases,
  normalizeRuntimeReport,
} from './runtime/model';

export {
  THEME_DECISION_PROTOCOL_VERSION,
  approveThemeDecision,
  createThemeDecisionDraft,
  relativeThemeModuleSpecifier,
  validateThemeDecisionApproval,
  validateThemeDecisionDraft,
} from './theme/model';
export { discoverThemeFacts } from './theme/discover';
export { inspectThemeBridge } from './theme/bridge';
export { THEME_TOPOLOGY_MODEL, inspectThemeTopology } from './theme/topology';
export type {
  ThemeTopologyInspection,
  ThemeTopologyKind,
  ThemeTopologyObservation,
} from './theme/topology';
export {
  inspectThemeBridgeCandidate,
  inspectThemeBridgeSources,
} from './theme/bridge';
export type {
  ThemeBridgeInspection,
  ThemeBridgeObservation,
} from './theme/bridge';
export {
  resolveThemeDecisionDefinition,
  resolveThemeValue,
} from './theme/resolve';
export type { ThemeValueResolution } from './theme/resolve';
export { scaffoldThemeDecisionDefinition } from './theme/scaffold';
export { themeConsumerCandidates } from './theme/candidates';
export type {
  ThemeConsumerCandidate,
  ThemeConsumerCandidateReport,
} from './theme/candidates';
export { emitThemeModule } from './theme/emit';
export { proposeApprovedThemeFiles } from './theme/rewrite';
export type {
  ThemeProposal,
  ThemeProposalOutcome,
  ThemeProposalSiteSpan,
} from './theme/rewrite';
export {
  THEME_NO_RUNTIME_LIMITATION,
  THEME_BRIDGE_LIMITATION,
  THEME_BRIDGE_UNOBSERVED_LIMITATION,
  approvePersistedThemeDecision,
  assertActiveThemeCandidateDecisions,
  inspectThemeDecision,
  loadThemeDecisionApproval,
  loadThemeDecisionDraft,
  persistThemeDecisionDraft,
  validateThemeDecisionAgainstInventory,
} from './theme/decisions';
export type { ThemeDecisionInspection } from './theme/decisions';
export { proposeThemeDecisionCandidate } from './theme/candidate';
export type { ThemeCandidateProposalResult } from './theme/candidate';
export {
  THEME_BRIDGE_TASK_PROTOCOL_VERSION,
  openThemeBridgeTask,
} from './theme/bridgeTask';
export type {
  ThemeDecisionApproval,
  ThemeBridgeCoverage,
  ThemeDecisionDraft,
  ThemeTokenMapDefinition,
  ThemeTokenMapping,
  ThemeValue,
  ThemeVariantDefinition,
} from './theme/model';
export {
  DYNAMIC_STRATEGY_PROTOCOL_VERSION,
  createDynamicStrategyDraft,
  validateDynamicStrategyDraft,
} from './dynamic/model';
export type {
  DynamicStrategyDefinition,
  DynamicStrategyDraft,
  DynamicStrategyEntry,
  DynamicStrategyKind,
} from './dynamic/model';
export {
  assertCurrentDynamicStrategy,
  currentDynamicStrategy,
  inspectDynamicStrategy,
  loadDynamicStrategyDraft,
  persistDynamicStrategyDraft,
  validateDynamicStrategyAgainstCurrentProject,
} from './dynamic/decisions';
export type { DynamicStrategyInspection } from './dynamic/decisions';
export {
  DYNAMIC_STRATEGY_WIRING_LIMITATION,
  DYNAMIC_STRATEGY_WIRING_MODEL,
  inspectDynamicStrategyCandidate,
} from './dynamic/guard';
export type { DynamicStrategyGuardResult } from './dynamic/guard';
export { runRuntimeCommandProvider } from './runtime/provider';
export { runGeneratedRuntimeProbeProvider } from './runtime/generatedProbe';
export {
  RUNTIME_SURFACE_DISCOVERY_VERSION,
  inspectRuntimeSurfaces,
} from './runtime/discover';
export type {
  RuntimeSurfaceDiscovery,
  RuntimeSurfaceInspection,
  RuntimeSurfaceKind,
} from './runtime/discover';
export { aggregateRuntimeCoverage } from './runtime/coverage';
export type {
  RuntimeCaseCoverageEntry,
  RuntimeCaseCoverageStatus,
  RuntimeCoverageStatus,
  RuntimeCoverageSummary,
} from './runtime/coverage';
export type {
  RuntimeCaseComparison,
  RuntimeCaseDefinition,
  RuntimeCaseObservation,
  RuntimeComparison,
  RuntimeDifference,
  RuntimeEnvironment,
  RuntimeExpectedObservations,
  RuntimeObservation,
  RuntimeObservationReport,
  RuntimeViewport,
} from './runtime/model';

export {
  CONTEXT_MAX_ATTEMPTS,
  CONTEXT_PROTOCOL_VERSION,
  createContextAttemptCapsule,
  createContextTaskCapsule,
  validateContextAttemptCapsule,
  validateContextTaskCapsule,
} from './context/capsule';
export {
  abandonContextTask,
  inspectContextTask,
  openContextRetry,
  openContextTask,
  recordContextVerificationOutcome,
  submitContextAttempt,
} from './context/lifecycle';
export type {
  ContextInspection,
  ContextOpenResult,
  ContextSubmitResult,
  ContextTaskState,
  ContextVerificationUpdate,
} from './context/lifecycle';
export type {
  ContextAttemptCapsule,
  ContextDeclaredInput,
  ContextFailure,
  ContextRequiredOutput,
  ContextRequiredCheck,
  ContextScope,
  ContextTaskCapsule,
  ContextTaskOrigin,
} from './context/capsule';

export { redact, redactText } from './state/redact';

export {
  createApplyPlanEvidenceSubject,
  createCandidateEvidenceSubject,
  repositoryEvidenceSubjectIdentity,
} from './evidence/subject';
export type {
  ApplyPlanEvidenceSubject,
  CandidateEvidenceSubject,
  CandidateSubjectInput,
  EvidenceChange,
  RepositoryEvidenceSubject,
} from './evidence/subject';

export { createFact, inventoryIdentity, siteIdentity } from './inventory/model';
export type {
  Classification,
  Cluster,
  ClusterConflict,
  ClusterSuggestion,
  Fact,
  FactProvenance,
  FactStatus,
  Inventory,
  InventoryDiagnostic,
  InventoryFile,
  Plan,
  PlanCounts,
  Site,
  SourceSpan,
} from './inventory/model';
export { scanRepository } from './inventory/scan';
export { inventoryReadiness } from './inventory/readiness';
export type { ReadinessSummary } from './inventory/readiness';
export { discoverStyledUsageFacts } from './adapters/emotion/styledUsage';
export {
  analyzeClosedStyledTemplate,
  discoverStyledTemplateFacts,
  readClosedStyledTemplate,
  STYLED_TEMPLATE_GRAMMAR_MODEL,
} from './adapters/emotion/styledTemplate';
export { analyzeProjectActivation } from './inventory/activation';
export type { ProjectActivation } from './inventory/activation';
export { analyzeLocalDependencies } from './inventory/resolve';
export type { LocalDependency } from './inventory/model';
export { proposeMechanicalCandidate } from './mechanical/candidate';
export type { MechanicalCandidateProposalResult } from './mechanical/candidate';
export { proposeStyledCandidate } from './styled/candidate';
export type { StyledCandidateProposalResult } from './styled/candidate';
export {
  createPlan,
  detectClusterConflicts,
  planIdentity,
  suggestClusters,
} from './planning/plan';
export {
  inventoryCounts,
  loadCurrentInventory,
  loadCurrentPlan,
  loadInventory,
  loadPlan,
  saveInventory,
  savePlan,
} from './planning/reports';

export {
  hashBytes,
  hashFields,
  hashString,
  shortHash,
  HASH_ALGORITHM,
} from './kernel/hash';

export {
  bindSnapshotAssumptionArtifacts,
  bindSnapshotDecisionArtifacts,
  canonicalRoot,
  createSnapshot,
  detectMovedHead,
  detectStaleFiles,
  extendSnapshot,
  gitCommitOf,
  isWorktreeClean,
  snapshotDecisionArtifactHashes,
  snapshotAssumptionArtifactHashes,
  snapshotHash,
} from './kernel/snapshot';
export type { WorkspaceSnapshot } from './kernel/snapshot';

export {
  allowedTransitions,
  canTransition,
  isTerminal,
  transition,
} from './kernel/state';
export type { Actor, MigrationState } from './kernel/state';

export {
  assertCleanWorktree,
  createCandidateWorkspace,
  materializeFullCheckout,
  removeCandidateWorkspace,
} from './candidate/workspace';
export type { CandidateWorkspace } from './candidate/workspace';

export { changedPaths, createCandidatePatch, isEmpty } from './candidate/patch';
export type {
  CandidatePatch,
  CandidateResult,
  FileChange,
  Proposer,
  ProposerKind,
} from './candidate/patch';

export {
  DEFAULT_FORBIDDEN_PATHS,
  LEDGER_DIRECTORY,
  globToRegExp,
  matchesGlob,
  validateScope,
} from './candidate/scope';
export type {
  ChangedPath,
  FileChangeStatus,
  ScopeResult,
  ScopeRules,
  ScopeViolation,
  ScopeViolationReason,
} from './candidate/scope';

/**
 * The writer itself is not exported. Reaching the user's files goes through a
 * apply plan, which requires an immutable candidate, evidence bound to that
 * candidate's hash, and an approval naming it. Exposing the low-level writer
 * would make all of that optional.
 */
export type { WriteIO, WriteResult } from './candidate/write';

export {
  approve,
  bundleEvidence,
  applyPlan,
  isMechanicalComparisonModel,
  MECHANICAL_COMPARISON_MODEL,
  MECHANICAL_COMPARISON_MODELS,
  MECHANICAL_POLICY_ID,
} from './kernel/applyPlan';
export type {
  Approval,
  ApplyPlan,
  ApplyPlanEntry,
  ApplyPlanResult,
  EvidenceBundle,
} from './kernel/applyPlan';

export { parseSource, pluginsForFilename } from './static/parse';
export type { ParseResult } from './static/parse';

export {
  hasConditions,
  hasMediaQueries,
  hasPseudoElements,
  isEmptyStyle,
  styleObject,
} from './static/ir';
export type {
  Condition,
  Declaration,
  PseudoElement,
  StaticValue,
  StaticKeyframe,
  StaticKeyframeDeclaration,
  StaticKeyframesValue,
  StyleValue,
  StyleObject,
} from './static/ir';

export { walk } from './static/walk';

export {
  STYLEX_MODULE,
  allocateKeys,
  emitCreateCall,
  emitImport,
  emitPropsSpread,
  emitStyleObject,
  sanitizeKey,
  serializeValue,
} from './static/emit';
export type { StyleEntry } from './static/emit';

export { applyEdits } from './static/rewrite';
export type { Edit } from './static/rewrite';

export {
  collectUsedNames,
  freeName,
  resolveModuleBinding,
} from './static/bindings';
export type { ModuleBinding } from './static/bindings';

export {
  COMPARISON_MODEL,
  canonicalValue,
  compareDeclarations,
  describeDifferences,
  parseDeclarations,
  parseRule,
} from './compare/model';
export type {
  ComparisonResult,
  CssDeclaration,
  Difference,
} from './compare/model';

export { allPassed, makeEvidence } from './kernel/evidence';
export type {
  Claim,
  CheckOutcome,
  EvidenceResult,
  EvidenceSubject,
} from './kernel/evidence';

export { evidence, packageVersion } from './evidence/claims';

export { compileStyleX } from './evidence/compile';
export type { CompiledStyleXRule, CompileResult } from './evidence/compile';
export { describeLintMessages, lintStyleX } from './evidence/lint';
export type { LintMessage, LintResult } from './evidence/lint';
export {
  stylexCascadeForKey,
  stylexCssForKey,
  stylexDirectionalForKey,
  stylexKeyframesForKey,
} from './evidence/staticCss';

export {
  emotionBaseline,
  emotionConditionalBaseline,
  emotionBoxShorthandBaseline,
  emotionDirectionalBaseline,
  emotionKeyframesBaseline,
  emotionMediaQueryBaseline,
  emotionPseudoElementBaseline,
  emotionSupportsNestingBaseline,
} from './adapters/emotion/baseline';

export {
  COMPILER_FACTS_MODEL,
  observeStyleXCompiler,
  STYLEX_COMPILER_PROVIDER,
} from './referee/compilerFacts';
export {
  activationStates,
  MEDIA_QUERY_REFEREE_MODEL,
  orderStyleXDeclarations,
  PSEUDO_ELEMENT_REFEREE_MODEL,
  referee,
  refereeMediaQueries,
  refereeSupportsNesting,
  refereePseudoElements,
  REFEREE_MODEL,
  SUPPORTS_NESTING_REFEREE_MODEL,
} from './referee/model';
export type {
  ActivationState,
  RefereeDeclaration,
  RefereeResult,
  Specificity,
  WinnerDifference,
} from './referee/model';
export {
  observeEmotionSerialization,
  observeStyleXCompilation,
  observeStyleXRules,
} from './referee/observations';
export type { CascadeObservation } from './referee/observations';
export {
  KEYFRAMES_REFEREE_MODEL,
  observeEmotionKeyframes,
  observeStyleXKeyframes,
  refereeKeyframes,
} from './referee/keyframes';
export type {
  KeyframesDeclaration,
  KeyframesFrame,
  KeyframesObservation,
  KeyframesObservationResult,
  KeyframesRefereeResult,
} from './referee/keyframes';
export {
  BOX_SHORTHAND_REFEREE_MODEL,
  expandBoxShorthand,
  observeEmotionBoxShorthands,
  refereeBoxShorthands,
} from './referee/shorthands';
export type {
  BoxShorthandObservation,
  BoxShorthandRefereeResult,
} from './referee/shorthands';
export {
  DIRECTIONAL_REFEREE_MODEL,
  DIRECTIONAL_STATES,
  observeEmotionDirectional,
  observeStyleXDirectionalRules,
  refereeDirectional,
} from './referee/directional';
export type {
  DirectionalDeclaration,
  DirectionalDifference,
  DirectionalObservation,
  DirectionalRefereeResult,
  DirectionalState,
} from './referee/directional';
export { RENDER_LOCAL_CSS_MODEL } from './referee/renderLocal';
export { CONDITIONAL_MUTATION_MANIFEST } from './referee/mutations';
export type {
  ConditionalMutationGate,
  ConditionalMutation,
  ConditionalMutationId,
  MutationGate,
} from './referee/mutations';
export { PSEUDO_ELEMENT_MUTATION_MANIFEST } from './referee/pseudoElementMutations';
export type {
  PseudoElementMutation,
  PseudoElementMutationId,
} from './referee/pseudoElementMutations';
export { MEDIA_QUERY_MUTATION_MANIFEST } from './referee/mediaQueryMutations';
export type {
  MediaQueryMutation,
  MediaQueryMutationId,
} from './referee/mediaQueryMutations';
export { SUPPORTS_NESTING_MUTATION_MANIFEST } from './referee/supportsNestingMutations';
export type {
  SupportsNestingMutation,
  SupportsNestingMutationId,
} from './referee/supportsNestingMutations';
export { KEYFRAMES_MUTATION_MANIFEST } from './referee/keyframesMutations';
export type {
  KeyframesMutation,
  KeyframesMutationId,
} from './referee/keyframesMutations';
export { SHORTHAND_MUTATION_MANIFEST } from './referee/shorthandMutations';
export type {
  ShorthandMutation,
  ShorthandMutationId,
} from './referee/shorthandMutations';
export { DIRECTIONAL_MUTATION_MANIFEST } from './referee/directionalMutations';
export type {
  DirectionalMutation,
  DirectionalMutationId,
} from './referee/directionalMutations';
export { RENDER_LOCAL_MUTATION_MANIFEST } from './referee/renderLocalMutations';
export type {
  RenderLocalMutation,
  RenderLocalMutationId,
} from './referee/renderLocalMutations';
export type {
  CompilerProbe,
  ObservedCompilerProbe,
  StyleXCompilerFacts,
} from './referee/compilerFacts';

/**
 * The supported way to convert an Emotion file. It runs the checks itself and
 * cannot return code that failed them.
 */
export {
  proposeStaticConversion,
  verifyConversion,
} from './proposers/emotionStatic';
export type { Proposal, ProposedEntry } from './proposers/emotionStatic';
export {
  convertClosedStyledDefinition,
  proposeClosedStyledConversion,
  STYLED_COMPARISON_MODEL,
  verifyStyledConversion,
} from './proposers/emotionStyled';
export type { StyledProposal } from './proposers/emotionStyled';
export {
  evaluateCorpusSources,
  formatCorpusSummary,
} from './evaluation/corpus';
export type { CorpusSource, CorpusSummary } from './evaluation/corpus';
export {
  comparePilotObservations,
  createPilotObservation,
  PILOT_PROTOCOL_VERSION,
} from './evaluation/pilot';
export type {
  Availability,
  MetricSummary,
  MutationObservation,
  NumericObservation,
  PilotArm,
  PilotComparison,
  PilotLane,
  PilotObservation,
  PilotOutcome,
} from './evaluation/pilot';

export {
  discover,
  isShorthandProperty,
  usesEmotion,
} from './adapters/emotion/discover';
export type {
  DiscoveryResult,
  EmotionRefusal,
  EmotionSite,
  RefusalReason,
} from './adapters/emotion/discover';
