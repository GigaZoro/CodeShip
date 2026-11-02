import { createFileRoute } from "@tanstack/react-router";

import { ProjectsPage } from "../components/projects/ProjectsPage";
import { validateProjectsSearch } from "../components/projects/projectsOverview.logic";

export const Route = createFileRoute("/_chat/projects")({
  validateSearch: validateProjectsSearch,
  component: ProjectsPage,
});
