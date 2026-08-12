/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { loadThemeDecisionDraft } from './decisions';
import {
  EVIDENCE_SURFACE_PROTOCOL_VERSION,
  SYNTHETIC_CSS_EXPECTATIONS_PROTOCOL_VERSION,
  normalizeEvidenceSurfaceDefinition,
} from '../runtime/evidenceSurfaceModel';
import { openEvidenceSurfaceTask } from '../runtime/evidenceSurfaceTask';
import {
  emitThemeProbeHarness,
  generatedThemeProbeServer,
} from './probeHarness';
import type { ContextOpenResult } from '../context/lifecycle';
import type { ProjectState } from '../state/project';
import type { ThemeDecisionDraft, ThemeValue } from './model';
import type {
  EvidenceSurfaceDefinition,
  RuntimeProbeAction,
} from '../runtime/evidenceSurfaceModel';

export const THEME_RUNTIME_PROBE_PROTOCOL_VERSION: string =
  'stylex-migrate-theme-runtime-probe-v2';
const GENERATED_ROOT_SELECTOR = '[data-stylex-migrate-probe="root"]';
const GENERATED_PORTAL_SELECTOR = '[data-stylex-migrate-probe="portal"]';

export type ThemeProbeProperty = {
  +sourcePath: string,
  +cssProperty: string,
  +numberSerialization?: 'raw' | 'px' | 'ms',
};

export type ThemeProbeTarget = {
  +selector: string,
  +properties: $ReadOnlyArray<ThemeProbeProperty>,
};

export type ThemeRuntimeProbeInput = {
  +protocolVersion: string,
  +packageRoot: string,
  +playwrightPackage: 'playwright' | '@playwright/test',
  +nativeSurfaceDisposition: 'none-known' | 'known-insufficient',
  +surface: 'repository' | 'generated-rspack',
  +server?: EvidenceSurfaceDefinition['server'],
  +path: string,
  +testedConsumerFiles: $ReadOnlyArray<string>,
  +siteIds: $ReadOnlyArray<string>,
  +viewport: {
    +width: number,
    +height: number,
    +deviceScaleFactor: number,
  },
  +activation: {
    +light: $ReadOnlyArray<RuntimeProbeAction>,
    +dark: $ReadOnlyArray<RuntimeProbeAction>,
  },
  +targets: {
    +root: ThemeProbeTarget,
    +portal: ThemeProbeTarget,
  },
  +rationale: string,
  +limitations: $ReadOnlyArray<string>,
};

function object(value: mixed): boolean {
  return value != null && !Array.isArray(value) && typeof value === 'object';
}

function strings(value: mixed): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === 'string' && item !== '' && !item.includes('\0'),
    )
  );
}

function input(value: mixed): ThemeRuntimeProbeInput {
  if (!object(value)) throw new Error('Invalid theme runtime-probe input');
  const source: $FlowFixMe = value;
  if (
    source.protocolVersion !== THEME_RUNTIME_PROBE_PROTOCOL_VERSION ||
    (source.surface !== 'repository' &&
      source.surface !== 'generated-rspack') ||
    (source.surface === 'repository' && !object(source.server)) ||
    (source.surface === 'generated-rspack' && source.server != null) ||
    typeof source.path !== 'string' ||
    source.path === '' ||
    !strings(source.testedConsumerFiles) ||
    !strings(source.siteIds) ||
    !object(source.viewport) ||
    !object(source.activation) ||
    !Array.isArray(source.activation.light) ||
    !Array.isArray(source.activation.dark) ||
    !object(source.targets) ||
    !object(source.targets.root) ||
    !object(source.targets.portal) ||
    typeof source.rationale !== 'string' ||
    source.rationale.trim() === '' ||
    !strings(source.limitations)
  ) {
    throw new Error('Invalid theme runtime-probe input');
  }
  return source as $FlowFixMe;
}

function serializedThemeValue(
  value: ThemeValue,
  property: ThemeProbeProperty,
): string {
  if (typeof value === 'string') return value;
  switch (property.numberSerialization) {
    case 'raw':
      return String(value);
    case 'px':
      return `${String(value)}px`;
    case 'ms':
      return `${String(value)}ms`;
    default:
      throw new Error(
        `Theme token ${property.sourcePath} has a numeric value; ${property.cssProperty} requires explicit numberSerialization`,
      );
  }
}

function targetDefinition(
  name: 'root' | 'portal',
  target: ThemeProbeTarget,
  draft: ThemeDecisionDraft,
  variant: 'light' | 'dark',
): {
  +probe: mixed,
  +expected: { +[property: string]: string },
} {
  if (
    typeof target.selector !== 'string' ||
    target.selector.trim() === '' ||
    !Array.isArray(target.properties) ||
    target.properties.length === 0
  ) {
    throw new Error(`Theme runtime probe requires a ${name} target`);
  }
  const tokens = new Map(
    draft.tokens.map((token) => [token.sourcePath, token]),
  );
  const expected: { [property: string]: string } = {};
  for (const property of target.properties) {
    if (
      !object(property) ||
      typeof property.sourcePath !== 'string' ||
      typeof property.cssProperty !== 'string'
    ) {
      throw new Error(`Invalid ${name} theme probe property`);
    }
    const token = tokens.get(property.sourcePath);
    if (token == null) {
      throw new Error(
        `Theme runtime probe token ${property.sourcePath} is not in ${draft.id}`,
      );
    }
    if (expected[property.cssProperty] != null) {
      throw new Error(
        `Theme runtime probe maps ${name}/${property.cssProperty} twice`,
      );
    }
    expected[property.cssProperty] = serializedThemeValue(
      token.values[variant],
      property,
    );
  }
  const computedProperties = Object.keys(expected).sort();
  return Object.freeze({
    probe: {
      id: name,
      selector: target.selector,
      computedProperties,
      attributes: [],
      observeDom: false,
      observeRef: false,
    },
    expected: Object.freeze(expected),
  });
}

export function createThemeRuntimeProbeDefinition({
  draft,
  value,
}: {
  +draft: ThemeDecisionDraft,
  +value: mixed,
}): EvidenceSurfaceDefinition {
  const definition = input(value);
  if (
    definition.surface === 'generated-rspack' &&
    (definition.targets.root.selector !== GENERATED_ROOT_SELECTOR ||
      definition.targets.portal.selector !== GENERATED_PORTAL_SELECTOR)
  ) {
    throw new Error(
      'Generated Rspack theme probes require the standard root and portal selectors',
    );
  }
  const variantNames = new Set(draft.variants.map((variant) => variant.name));
  if (!variantNames.has('light') || !variantNames.has('dark')) {
    throw new Error(
      `Theme runtime probes require exact light and dark variants in ${draft.id}`,
    );
  }
  const consumers = [...new Set(definition.testedConsumerFiles)].sort();
  if (definition.surface === 'repository' && consumers.length === 0) {
    throw new Error(
      'Repository theme runtime probes require at least one tested consumer file',
    );
  }
  if (consumers.some((file) => !draft.consumerFiles.includes(file))) {
    throw new Error(
      'Theme runtime probe consumer files must belong to the theme decision',
    );
  }
  if (draft.bridge == null) {
    throw new Error('Theme runtime probes require declared bridge boundaries');
  }
  const changePaths =
    definition.surface === 'generated-rspack'
      ? [draft.targetModule]
      : [
          ...new Set([
            draft.targetModule,
            ...draft.bridge.boundaryFiles,
            ...consumers,
          ]),
        ].sort();
  const generatedPort =
    30000 + (Number.parseInt(draft.definitionHash.slice(0, 8), 16) % 20000);
  const generatedServer = generatedThemeProbeServer(generatedPort);
  const cases = [];
  const expectedCases = [];
  const variants: $ReadOnlyArray<'light' | 'dark'> = ['light', 'dark'];
  const locations: $ReadOnlyArray<'root' | 'portal'> = ['root', 'portal'];
  for (const variant of variants) {
    for (const location of locations) {
      const id = `theme-${variant}-${location}`;
      const target = targetDefinition(
        location,
        definition.targets[location],
        draft,
        variant,
      );
      cases.push({
        id,
        changePaths,
        siteIds: definition.siteIds,
        theme: variant,
        interaction: 'initial',
        viewport: definition.viewport,
        path:
          definition.surface === 'generated-rspack'
            ? `/?theme=${variant}`
            : definition.path,
        actions:
          definition.surface === 'generated-rspack'
            ? []
            : definition.activation[variant],
        targets: [target.probe],
      });
      expectedCases.push({
        id,
        computedStyles: { [location]: target.expected },
      });
    }
  }
  return normalizeEvidenceSurfaceDefinition({
    protocolVersion: EVIDENCE_SURFACE_PROTOCOL_VERSION,
    packageRoot: definition.packageRoot,
    playwrightPackage: definition.playwrightPackage,
    nativeSurfaceDisposition: definition.nativeSurfaceDisposition,
    server:
      definition.surface === 'generated-rspack'
        ? generatedServer
        : definition.server,
    cases,
    expectedObservations: null,
    syntheticCssExpectations: {
      protocolVersion: SYNTHETIC_CSS_EXPECTATIONS_PROTOCOL_VERSION,
      source: {
        kind: 'theme-decision-draft',
        id: draft.id,
        definitionHash: draft.definitionHash,
      },
      cases: expectedCases,
    },
    rationale: definition.rationale,
    limitations: definition.limitations,
  });
}

export function openThemeRuntimeProbeTask({
  project,
  draftId,
  assumptionId,
  value,
  goal,
  workspaceRoot,
  now,
}: {
  +project: ProjectState,
  +draftId: string,
  +assumptionId: string,
  +value: mixed,
  +goal: string,
  +workspaceRoot?: string,
  +now?: () => string,
}): ContextOpenResult {
  const draft = loadThemeDecisionDraft(project, draftId);
  if (draft == null) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([`No theme decision found for ${draftId}.`]),
    };
  }
  const definitionInput = input(value);
  return openEvidenceSurfaceTask({
    project,
    assumptionId,
    input: createThemeRuntimeProbeDefinition({ draft, value }),
    supportOutputs:
      definitionInput.surface === 'generated-rspack'
        ? emitThemeProbeHarness({
            draft,
            targets: definitionInput.targets,
            port:
              30000 +
              (Number.parseInt(draft.definitionHash.slice(0, 8), 16) % 20000),
          })
        : [],
    goal,
    workspaceRoot,
    now,
  });
}
