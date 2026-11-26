import { msg, t } from "@t3tools/shared/i18n";
import * as Schema from "effect/Schema";

export const SAVED_VIEW_NAME_MAX_LENGTH = 80;

export const SavedViewIdentity = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(SAVED_VIEW_NAME_MAX_LENGTH)),
});

export function savedViewNameError(
  name: string,
  views: ReadonlyArray<typeof SavedViewIdentity.Type>,
  editingId?: string,
  resolve: typeof t = t,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return resolve(msg("Enter a name for this view."));
  if (trimmed.length > SAVED_VIEW_NAME_MAX_LENGTH) {
    return resolve(msg("Use {max} characters or fewer."), { max: SAVED_VIEW_NAME_MAX_LENGTH });
  }
  return views.some(
    (view) => view.id !== editingId && view.name.toLowerCase() === trimmed.toLowerCase(),
  )
    ? resolve(msg("A view with this name already exists."))
    : null;
}
