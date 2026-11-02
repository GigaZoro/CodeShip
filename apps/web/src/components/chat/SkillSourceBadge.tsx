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

const SKILL_SOURCE_LABEL_BY_KIND: Record<ProviderSkillSourceKind, string> = {
  app: "App",
  repo: "Repo",
  project: "Project",
  personal: "Personal",
  system: "System",
  other: "Provider",
};

export function SkillSourceBadge(props: {
  readonly kind: ProviderSkillSourceKind;
  readonly showSkillSuffix?: boolean;
  readonly className?: string;
}) {
  const Icon = SKILL_SOURCE_ICON_BY_KIND[props.kind];
  return (
    <Badge className={props.className} variant="secondary">
      <Icon aria-hidden="true" className="text-current" />
      {SKILL_SOURCE_LABEL_BY_KIND[props.kind]}
      {props.showSkillSuffix ? " Skill" : null}
    </Badge>
  );
}
