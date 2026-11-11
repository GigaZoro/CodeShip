import { useAtomValue } from "@effect/atom-react";
import {
  detectedManualStepAccountLabel,
  type DetectedManualStepEntry,
} from "@t3tools/client-runtime/state/manualSteps";
import {
  signInOutcomeText,
  signInPendingCountText,
  signInPositionText,
} from "@t3tools/client-runtime/state/manualStepsSignIn";
import {
  currentSignIn,
  mcpSignInProgress,
  outcomeOfProgress,
  providerReadsSignedIn,
  providerSignInProgress,
  recordSignInOutcome,
  startSignInSession,
  summarizeSignIns,
  type SignInOutcome,
  type SignInProgress,
} from "@t3tools/client-runtime/state/manualStepsSignIn.logic";
import { AuthProvidersManageScope, type ProviderMcpServerName } from "@t3tools/contracts";
import { CircleAlertIcon, CircleCheckIcon, CircleMinusIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { McpSignInFlow } from "../mcp/McpSignInFlow";
import { ProviderAuthenticationSection } from "../settings/ProviderAuthenticationSection";
import { SettingsGroup } from "../settings/SettingsGroup";
import { providerClients } from "../settings/providerDriverMeta";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { detectedStepText } from "./detectedManualStep";
import { t } from "~/i18n";

const OUTCOME_ICON = {
  "signed-in": { Icon: CircleCheckIcon, className: "text-success-foreground" },
  skipped: { Icon: CircleMinusIcon, className: "text-muted-foreground" },
  failed: { Icon: CircleAlertIcon, className: "text-destructive-foreground" },
} as const;

function OutcomeLine(props: { readonly outcome: SignInOutcome }) {
  const { Icon, className } = OUTCOME_ICON[props.outcome.status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${className}`} role="status">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {signInOutcomeText(props.outcome)}
    </span>
  );
}

/** One step's controls: its position, what it is, and Skip and Next once it has an answer. */
function StepFrame(props: {
  readonly entry: DetectedManualStepEntry;
  readonly position: number;
  readonly total: number;
  readonly last: boolean;
  /** What Next records; null until the step has an answer. */
  readonly outcome: SignInOutcome | null;
  readonly onResolve: (outcome: SignInOutcome) => void;
  readonly children: ReactNode;
}) {
  const text = detectedStepText(props.entry);
  const { outcome } = props;
  return (
    <>
      <DialogHeader>
        <p className="text-muted-foreground text-xs tabular-nums">
          {props.entry.step.machine} · {signInPositionText(props.position, props.total)}
        </p>
        <DialogTitle>{text.step}</DialogTitle>
        <DialogDescription>{text.detail}</DialogDescription>
      </DialogHeader>
      {props.children}
      <DialogFooter>
        <div className="me-auto flex items-center">
          {outcome ? <OutcomeLine outcome={outcome} /> : null}
        </div>
        <Button
          variant="outline"
          onClick={() => props.onResolve({ status: "skipped", reason: "user" })}
        >
          {t("Skip")}
        </Button>
        <Button disabled={outcome === null} onClick={() => outcome && props.onResolve(outcome)}>
          {props.last ? t("Finish") : t("Next")}
        </Button>
      </DialogFooter>
    </>
  );
}

interface StepProps {
  readonly entry: DetectedManualStepEntry;
  readonly position: number;
  readonly total: number;
  readonly last: boolean;
  readonly onResolve: (outcome: SignInOutcome) => void;
}

/** The existing account card, with its terminal, link and callback paste, for one account. */
function ProviderStep(props: StepProps) {
  const { entry } = props;
  const { environmentId, step } = entry;
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const provider = providers.find((candidate) => candidate.instanceId === step.instanceId);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const query = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId: step.instanceId } }),
  );
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, {
    reportFailure: false,
    reportDefect: false,
  });
  const auth = query.data ?? undefined;
  // The flow the account had when the step began; only a later one answers for this step.
  const [baseline, setBaseline] = useState<{ readonly flowId: string | null } | null>(null);
  if (baseline === null && auth !== undefined) setBaseline({ flowId: auth.flowId });

  const progress: SignInProgress =
    provider === undefined
      ? {
          state: "failed",
          reason: "failed",
          message: t("This account is not available any more."),
        }
      : baseline === null
        ? { state: "pending" }
        : providerSignInProgress({
            kind: step.kind,
            baselineFlowId: baseline.flowId,
            signedIn: providerReadsSignedIn(provider, auth?.phase),
            flow: auth,
          });

  const activeFlowId =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying"
      ? auth.flowId
      : null;
  const cancelActiveFlow = useStableCallback(() => {
    if (activeFlowId !== null) {
      void cancel({ environmentId, input: { instanceId: step.instanceId, flowId: activeFlowId } });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leaving the step (Skip, Next or closing) ends the sign-in the server is still running for it
  useEffect(() => cancelActiveFlow, [cancelActiveFlow]);

  const outcome = outcomeOfProgress(progress);
  return (
    <StepFrame {...props} outcome={outcome}>
      <DialogPanel>
        {provider ? (
          <SettingsGroup variant="plain">
            <ProviderAuthenticationSection
              environmentId={environmentId}
              environmentLabel={step.machine}
              instanceId={step.instanceId}
              provider={provider}
              readOnly={!canManage}
            />
          </SettingsGroup>
        ) : null}
      </DialogPanel>
    </StepFrame>
  );
}

/** The existing MCP sign-in: its authorization link and the callback paste. */
function McpStep(props: StepProps) {
  const { serverName } = props.entry.step;
  // The server names every MCP step it reports; one without a name cannot be signed in.
  return serverName === undefined ? (
    <StepFrame
      {...props}
      outcome={{ status: "failed", reason: "failed", message: t("This server has no name.") }}
    >
      {null}
    </StepFrame>
  ) : (
    <McpStepFlow {...props} serverName={serverName} />
  );
}

function McpStepFlow(props: StepProps & { readonly serverName: ProviderMcpServerName }) {
  const { entry, serverName } = props;
  const { environmentId, step } = entry;
  const signIn = useEnvironmentQuery(
    serverEnvironment.providerMcpSignIn({
      environmentId,
      input: { instanceId: step.instanceId, name: serverName },
    }),
  );
  const progress = mcpSignInProgress({ phase: signIn.data?.phase, error: signIn.error });
  const outcome = outcomeOfProgress(progress);
  const account = detectedManualStepAccountLabel(
    step,
    providerClients.get(step.driver)?.label ?? step.driver,
  );
  return (
    <StepFrame {...props} outcome={outcome}>
      <McpSignInFlow
        embedded
        environmentId={environmentId}
        instanceId={step.instanceId}
        serverName={serverName}
        providerName={account}
        onClose={() => undefined}
      />
    </StepFrame>
  );
}

function Summary(props: {
  readonly session: ReturnType<typeof startSignInSession>;
  readonly onClose: () => void;
}) {
  const { signedIn, pending } = summarizeSignIns(props.session);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("Sign-ins finished")}</DialogTitle>
        <DialogDescription>
          {pending.length === 0
            ? t("Every sign-in is done.")
            : signInPendingCountText(pending.length)}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ul className="grid gap-2">
          {signedIn.map(({ entry, key }) => (
            <li key={key} className="grid gap-0.5 text-sm">
              <span>{detectedStepText(entry).step}</span>
              <OutcomeLine outcome={{ status: "signed-in" }} />
            </li>
          ))}
          {pending.map(({ step, outcome }) => (
            <li key={step.key} className="grid gap-0.5 text-sm">
              <span>{detectedStepText(step.entry).step}</span>
              <OutcomeLine outcome={outcome} />
            </li>
          ))}
        </ul>
      </DialogPanel>
      <DialogFooter>
        <Button onClick={props.onClose}>{t("Done")}</Button>
      </DialogFooter>
    </>
  );
}

/**
 * Walks one machine's detected sign-ins in the list's order, each in the flow that already signs
 * it in. Mounted only while open and walks the steps it was opened with, so a refresh that clears
 * one mid-walk does not shift the rest. Closing ends only the step in progress.
 */
export default function SignInAllDialog(props: {
  readonly entries: ReadonlyArray<DetectedManualStepEntry>;
  readonly onClose: () => void;
}) {
  const [session, setSession] = useState(() => startSignInSession(props.entries));
  const current = currentSignIn(session);
  const StepComponent = current?.step.entry.step.kind === "mcp-needs-auth" ? McpStep : ProviderStep;
  return (
    <Dialog open onOpenChange={(open) => (open ? null : props.onClose())}>
      <DialogPopup className="sm:max-w-xl">
        {current ? (
          <StepComponent
            key={current.step.key}
            entry={current.step.entry}
            position={current.position}
            total={current.total}
            last={current.last}
            onResolve={(outcome) =>
              setSession((previous) => recordSignInOutcome(previous, current.step.key, outcome))
            }
          />
        ) : (
          <Summary session={session} onClose={props.onClose} />
        )}
      </DialogPopup>
    </Dialog>
  );
}
