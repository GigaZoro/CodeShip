import { msg, t, type Message } from "~/i18n";
import type { ProviderSkillSourceKind } from "@t3tools/client-runtime/providerSkills";
import {
  BlocksIcon,
  FolderIcon,
  PackageIcon,
  SettingsIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "../ui/badge";

const SKILL_SOURCE_ICON_BY_KIND: Record<ProviderSkillSourceKind, LucideIcon> = {
  app: BlocksIcon,
  repo: FolderIcon,
  project: FolderIcon,
  personal: UserRoundIcon,
  system: SettingsIcon,
  other: PackageIcon,
};

const SKILL_SOURCE_LABEL_BY_KIND: Record<ProviderSkillSourceKind, Message> = {
  app: msg("App"),
  repo: msg("Repo"),
  project: msg("Project"),
  personal: msg("Personal"),
  system: msg("System"),
  other: msg("Provider"),
};

export function skillSourcePresentation(kind: ProviderSkillSourceKind) {
  return { Icon: SKILL_SOURCE_ICON_BY_KIND[kind], label: t(SKILL_SOURCE_LABEL_BY_KIND[kind]) };
}

export function SkillSourceBadge(props: {
  readonly kind: ProviderSkillSourceKind;
  readonly showSkillSuffix?: boolean;
  readonly className?: string;
}) {
  const { Icon, label } = skillSourcePresentation(props.kind);
  return (
    <Badge className={props.className} variant="secondary">
      <Icon aria-hidden="true" className="text-current" />
      {props.showSkillSuffix ? t("{source} Skill", { source: label }) : label}
    </Badge>
  );
}
