#! /usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * L0 CLI — `stylex-codemod emotion "<glob>" [--write] [--config <path>]
 * [--render-check]`.
 *
 * DRY RUN IS THE DEFAULT: with no `--write`, nothing is written; you get a
 * convert / refuse / TODO report to preview. `--write` applies the changes.
 * `--render-check` renders the clean conversions in a real browser and diffs
 * computed styles — the confidence pass for the trusted (dynamic/theme)
 * conversions the static gate can't fully verify.
 */

import yargs from 'yargs';
// $FlowFixMe[cannot-resolve-module] - yargs/helpers has no flow libdef here
import { hideBin } from 'yargs/helpers';
import { loadConfig } from '../config/loadConfig';
import { runCodemod } from './run';
import { formatReport } from './report';
import { runInit } from './init';
import { runRenderCheck } from './renderCheckRun';
import { formatRenderCheckReport } from '../testing/renderCheck';

export async function main(argv: $ReadOnlyArray<string>): Promise<number> {
  const args = yargs([...argv])
    .scriptName('stylex-codemod')
    .usage('$0 <adapter> <glob..> [options]')
    .command('emotion <glob..>', 'Migrate Emotion styles to StyleX')
    .command('init', 'Scaffold stylex-codemod.config.js + print a quick-start')
    .positional('glob', {
      describe: 'File glob(s) to transform',
      type: 'string',
    })
    .option('write', {
      type: 'boolean',
      default: false,
      describe: 'Apply changes (default: dry run — preview only)',
    })
    .option('config', {
      type: 'string',
      describe: 'Path to a stylex-codemod.config.js',
    })
    .option('diff', {
      type: 'boolean',
      default: false,
      describe: 'Show the unified diff of each conversion (preview the change)',
    })
    .option('render-check', {
      type: 'boolean',
      default: false,
      describe:
        'Render clean conversions in a real browser and diff computed styles ' +
        '(confidence pass; needs Chrome)',
    })
    .option('verbose', {
      type: 'boolean',
      default: false,
      describe: 'List unchanged files and every TODO reason',
    })
    .demandCommand(1)
    .strict()
    .help()
    .parseSync();

  const command = String(args._[0]);
  if (command === 'init') {
    const result = runInit(process.cwd());
    process.stdout.write(`${result.message}\n`);
    return 0;
  }
  if (command !== 'emotion') {
    process.stderr.write(
      `Unknown command '${command}' (use 'emotion' or 'init').\n`,
    );
    return 2;
  }

  const patterns = (args.glob ?? []).map(String);
  const config = loadConfig({ configPath: args.config ?? null });
  const diff = Boolean(args.diff);
  const report = runCodemod({
    patterns,
    config,
    write: Boolean(args.write),
    diff,
  });
  process.stdout.write(
    `${formatReport(report, { verbose: Boolean(args.verbose), diff })}\n`,
  );

  let renderMismatches = 0;
  if (args['render-check'] === true) {
    process.stdout.write('\nRunning render check…\n');
    const renderReport = await runRenderCheck({ patterns, config });
    process.stdout.write(`${formatRenderCheckReport(renderReport)}\n`);
    renderMismatches = renderReport.mismatched;
  }

  return report.summary.errors > 0 || renderMismatches > 0 ? 1 : 0;
}

// $FlowFixMe[cannot-resolve-module] - require.main is a runtime guard
if (require.main === module) {
  main(hideBin(process.argv)).then((code) => process.exit(code));
}
