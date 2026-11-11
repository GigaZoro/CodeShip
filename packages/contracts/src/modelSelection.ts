import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelection, ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
  /**
   * Auto: runs the `autoModeModels` entry for Auto's provider (see `resolveAutoModelSelection`)
   * on the first account in the saved account order with usage left. `instanceId` names the
   * account the selection last ran on.
   */
  autoAccount: Schema.optionalKey(Schema.Boolean),
});

const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
  autoAccount: Schema.optional(Schema.Unknown),
});

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformEffect({
      decode: (raw) => {
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === "string"
              ? raw.provider
              : undefined;
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        };
        if (raw.options !== undefined) base.options = raw.options;
        if (raw.autoAccount !== undefined) base.autoAccount = raw.autoAccount;
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
      },
      encode: (value) => {
        const base: Record<string, unknown> = {
          instanceId: value.instanceId,
          model: value.model,
        };
        if (value.options !== undefined) base.options = value.options;
        if (value.autoAccount !== undefined) base.autoAccount = value.autoAccount;
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
      },
    }),
  ),
);
export type ModelSelection = typeof ModelSelection.Type;

/**
 * Strict input shape for MCP tools. `ModelSelection` also decodes the legacy `provider` field and
 * option objects for stored data; advertising that would hide the identity every caller must send.
 */
const AdvertisedNonEmptyString = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.decodeTo(TrimmedNonEmptyString),
);

export const CanonicalModelSelection = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: AdvertisedNonEmptyString,
  options: Schema.optionalKey(Schema.Array(ProviderOptionSelection)),
  autoAccount: Schema.optionalKey(Schema.Boolean),
});
