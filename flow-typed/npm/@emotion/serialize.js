/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * @flow strict
 */

declare module '@emotion/serialize' {
  declare export type SerializedStyles = {
    +name: string,
    +styles: string,
    +map?: string,
    +next?: SerializedStyles,
    ...
  };

  declare export function serializeStyles(
    args: $ReadOnlyArray<mixed>,
    registered?: ?{ +[string]: string, ... },
    mergedProps?: mixed,
  ): SerializedStyles;
}
