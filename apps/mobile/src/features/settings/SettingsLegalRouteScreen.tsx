import { t } from "../../lib/i18n";
import { SettingsLegalDocumentRouteScreen } from "./components/SettingsLegalDocumentRouteScreen";
import { LEGAL_URL } from "./lib/legal-document-url";

export function SettingsLegalRouteScreen() {
  return <SettingsLegalDocumentRouteScreen documentName={t("Legal")} documentUrl={LEGAL_URL} />;
}
