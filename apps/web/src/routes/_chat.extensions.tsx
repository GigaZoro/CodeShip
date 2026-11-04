import { createFileRoute } from "@tanstack/react-router";

import { ExtensionsPage } from "../components/extensions/ExtensionsPage";
import { validateExtensionsSearch } from "../components/extensions/extensionsSearch";

export const Route = createFileRoute("/_chat/extensions")({
  validateSearch: validateExtensionsSearch,
  component: ExtensionsPage,
});
