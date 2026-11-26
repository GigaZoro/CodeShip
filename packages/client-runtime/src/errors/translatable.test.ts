import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import { squashAtomCommandFailure } from "../state/runtime.ts";
import { msg } from "@t3tools/shared/i18n";
import { markMessage } from "@t3tools/shared/markedMessage";
import {
  errorDisplayMessage,
  markedTextEnglish,
  translatableError,
  thrownErrorMessage,
} from "./translatable.ts";

const decodeDefect = Schema.decodeUnknownSync(Schema.Defect());

describe("thrownErrorMessage", () => {
  it("shows the text of a string defect that came back over RPC", () => {
    const defect = decodeDefect(
      "RPC contract is registered but unavailable in the control plane: projectClone.start",
    );
    const error = squashAtomCommandFailure({ cause: Cause.die(defect) });

    expect(thrownErrorMessage(error)).toBe(
      "RPC contract is registered but unavailable in the control plane: projectClone.start",
    );
  });
});

it("keeps released error sentences readable across languages, including colons and UTF-8 values", () => {
  const wire =
    "Host А:Б:eyJuYW1lIjoi0JA60JEiLCIkX3NvdXJjZSI6Ikhvc3Qge25hbWV9IiwiJF9oYXNoIjoiMDFiOTU0MTBjOGUyOTE1OCJ9";
  expect(markMessage(msg("Host {name}"), { name: "А:Б" })).toBe(wire);
  const error = translatableError(wire, msg("Disconnected"));
  expect(error.message).toBe("Host А:Б Disconnected");
  expect(
    errorDisplayMessage(error, (key, values) =>
      key === "Host {name}" ? `Вузол ${values?.name}` : "Відключено",
    ),
  ).toBe("Вузол А:Б Відключено");
  expect(thrownErrorMessage(new Error("provider: raw"))).toBe("provider: raw");
});

it("uses rendered English for legacy ICU choices and keeps malformed message suffixes verbatim", () => {
  const choice =
    "2 files:eyJjb3VudCI6MiwiJF9zb3VyY2UiOiJ7Y291bnQsIHBsdXJhbCwgb25lIHsjIGZpbGV9IG90aGVyIHsjIGZpbGVzfX0iLCIkX2hhc2giOiIxMjM0In0=";
  expect(errorDisplayMessage(translatableError(choice))).toBe("2 files");
  expect(markedTextEnglish(["rpc: error", "peer:bnVsbA==", "x:eyJ4IjoxfQ=="])).toBe(
    "rpc: error peer:bnVsbA== x:eyJ4IjoxfQ==",
  );
});
