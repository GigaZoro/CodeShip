import { createFileRoute, redirect } from "@tanstack/react-router";

import { validateSkillsSearch } from "../components/skills/skillsPage.logic";

export const Route = createFileRoute("/_chat/skills")({
  validateSearch: validateSkillsSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/extensions", search: { ...search, tab: "skills" }, replace: true });
  },
});
