import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { WelcomeWizard } from "../components/onboarding/WelcomeWizard";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { clearSetupReturnHref, takeSetupReturnHref } from "../onboarding/setupRerun";

const decodeEnvironmentId = Schema.decodeOption(EnvironmentId);

export const Route = createFileRoute("/welcome")({
  beforeLoad: ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  // A re-run abandoned before finishing must not send a later first run to a stale page.
  onLeave: clearSetupReturnHref,
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  const { authGateState } = Route.useRouteContext();
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const resumeEnvironmentId = hash.startsWith("agents:")
    ? Option.getOrUndefined(decodeEnvironmentId(hash.slice("agents:".length)))
    : undefined;
  // The root can remount this pending outlet after navigation; do not reopen setup.
  const isWelcomeRoute = useLocation({ select: (location) => location.pathname === "/welcome" });
  const [dismissed, setDismissed] = useState(false);
  const openNewThread = useNewThreadHandler();
  const localAvailable = authGateState.status === "authenticated";
  return (
    <>
      <NoProjectsHero />
      {isWelcomeRoute && !dismissed ? (
        <WelcomeWizard
          localAvailable={localAvailable}
          resumeEnvironmentId={resumeEnvironmentId}
          onDone={async (projectRef) => {
            setDismissed(true);
            if (projectRef !== undefined) {
              await openNewThread(projectRef, { replace: true }).catch(() =>
                navigate({ to: "/", replace: true }),
              );
              return;
            }
            const returnHref = takeSetupReturnHref();
            await (returnHref === null
              ? navigate({ to: "/", replace: true })
              : navigate({ href: returnHref, replace: true }));
          }}
        />
      ) : null}
    </>
  );
}
