/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { runCommandProvider } from './command';
import { runRuntimeCommandProvider } from '../runtime/provider';
import { runGeneratedRuntimeProbeProvider } from '../runtime/generatedProbe';
import { runBootstrapRspackProvider } from '../bootstrap/provider';
import { runBootstrapBabelProvider } from '../bootstrap/babelProvider';
import type { CommandExecution, CommandExecutionContext } from './command';
import type { EvidenceProviderConfig } from './config';

export type EvidenceProviderRunner = (
  config: EvidenceProviderConfig,
  context: CommandExecutionContext,
) => Promise<CommandExecution>;

export type EvidenceProviderRegistry = {
  +get: (kind: string) => EvidenceProviderRunner,
  +kinds: () => $ReadOnlyArray<string>,
  +register: (kind: string, runner: EvidenceProviderRunner) => void,
};

export function createEvidenceProviderRegistry(): EvidenceProviderRegistry {
  const runners = new Map<string, EvidenceProviderRunner>();
  const registry = {
    get(kind: string): EvidenceProviderRunner {
      const runner = runners.get(kind);
      if (runner == null) {
        throw new Error(
          `No evidence provider runner is registered for ${kind}`,
        );
      }
      return runner;
    },
    kinds(): $ReadOnlyArray<string> {
      return Object.freeze([...runners.keys()].sort());
    },
    register(kind: string, runner: EvidenceProviderRunner): void {
      if (kind === '' || runners.has(kind)) {
        throw new Error(
          `Evidence provider runner already registered for ${kind}`,
        );
      }
      runners.set(kind, runner);
    },
  };
  registry.register('command', (config, context) => {
    if (config.kind !== 'command') {
      throw new Error('Command runner received another provider kind');
    }
    return runCommandProvider(config, context);
  });
  registry.register('runtime-command', (config, context) => {
    if (config.kind !== 'runtime-command') {
      throw new Error('Runtime runner received another provider kind');
    }
    return runRuntimeCommandProvider(config, context);
  });
  registry.register('generated-runtime-probe', (config, context) => {
    if (config.kind !== 'generated-runtime-probe') {
      throw new Error(
        'Generated runtime runner received another provider kind',
      );
    }
    return runGeneratedRuntimeProbeProvider(config, context);
  });
  registry.register('bootstrap-rspack', (config, context) => {
    if (config.kind !== 'bootstrap-rspack') {
      throw new Error('Bootstrap Rspack runner received another provider kind');
    }
    return runBootstrapRspackProvider(config, context);
  });
  registry.register('bootstrap-babel', (config, context) => {
    if (config.kind !== 'bootstrap-babel') {
      throw new Error('Bootstrap Babel runner received another provider kind');
    }
    return runBootstrapBabelProvider(config, context);
  });
  return Object.freeze(registry);
}
