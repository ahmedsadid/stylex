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
  CommandProviderConfig,
  EvidenceConfig,
  EvidenceCost,
  EvidenceProviderConfig,
  EvidenceSubjectKind,
  RepositoryCheck,
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
export { analyzeProjectActivation } from './inventory/activation';
export type { ProjectActivation } from './inventory/activation';
export { analyzeLocalDependencies } from './inventory/resolve';
export type { LocalDependency } from './inventory/model';
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
  canonicalRoot,
  createSnapshot,
  detectMovedHead,
  detectStaleFiles,
  extendSnapshot,
  gitCommitOf,
  isWorktreeClean,
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
