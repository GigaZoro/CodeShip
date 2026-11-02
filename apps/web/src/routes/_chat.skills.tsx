import { createFileRoute } from "@tanstack/react-router";

import { SkillsPage } from "../components/skills/SkillsPage";
import { validateSkillsSearch } from "../components/skills/skillsPage.logic";

export const Route = createFileRoute("/_chat/skills")({
  validateSearch: validateSkillsSearch,
  component: SkillsPage,
});
