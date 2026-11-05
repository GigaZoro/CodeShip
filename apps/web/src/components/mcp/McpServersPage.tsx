import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ProviderMcpServer } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  CircleOffIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { failureMessage, reportFailure } from "../extensions/commandFailure";
import {
  MachinePicker,
  ProviderListSkeleton,
  ProviderTargetAccounts,
  ProviderTargetIcon,
  useProviderTargets,
  type ProviderTarget,
  type ProviderTargetMachine,
} from "../extensions/ProviderTargets";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import {
  readMcpServerForm,
  type McpServerForm,
  type McpServerFormField,
  type McpServerKind,
} from "./mcpServerForm";
import { msg, t, tn, type Message } from "~/i18n";

const FAILURE_FALLBACK = msg("The provider could not finish the change.");

const serverLabel = (server: ProviderMcpServer) => server.displayName ?? server.name;

const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

function openInBrowser(url: string) {
  void readLocalApi()
    ?.shell.openExternal(url)
    .catch(() =>
      toastManager.add({
        type: "error",
        title: t("Could not open the sign-in page"),
        description: t("Copy the link from this dialog and open it in your browser."),
      }),
    );
}

const STATUS_LOOKS: Record<
  ProviderMcpServer["status"],
  { readonly label: Message; readonly icon: LucideIcon; readonly className: string }
> = {
  connected: {
    label: msg("Connected"),
    icon: CircleCheckIcon,
    className: "text-success-foreground",
  },
  needsAuth: {
    label: msg("Needs sign-in"),
    icon: KeyRoundIcon,
    className: "text-warning-foreground",
  },
  failed: {
    label: msg("Failed to connect"),
    icon: CircleAlertIcon,
    className: "text-destructive-foreground",
  },
  starting: {
    label: msg("Still starting"),
    icon: CircleDashedIcon,
    className: "text-muted-foreground",
  },
  disabled: { label: msg("Turned off"), icon: CircleOffIcon, className: "text-muted-foreground" },
  notConfigured: {
    label: msg("Not set up"),
    icon: CircleMinusIcon,
    className: "text-muted-foreground",
  },
};

function ServerStatus(props: { readonly server: ProviderMcpServer }) {
  const { server } = props;
  const look = STATUS_LOOKS[server.status];
  const Icon = look.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${look.className}`}>
      <Icon className="size-3.5" aria-hidden />
      {t(look.label)}
      {server.status === "connected" && server.toolCount !== undefined ? (
        <span className="text-muted-foreground tabular-nums">
          · {tn(server.toolCount, "{count} tool", "{count} tools")}
        </span>
      ) : null}
    </span>
  );
}

function originBadge(server: ProviderMcpServer, providerName: string) {
  switch (server.origin) {
    case "config":
      return null;
    case "plugin":
      return {
        label: server.plugin ? t("Plugin: {plugin}", { plugin: server.plugin }) : t("Plugin"),
        hint: t("A plugin adds this server. Manage it on the Plugins page."),
      };
    case "connector":
      return { label: "claude.ai", hint: t("Connect or remove this connector on claude.ai.") };
    case "managed":
      return { label: t("Managed"), hint: t("Your organization's policy adds this server.") };
    case "builtIn":
      return {
        label: t("Built in"),
        hint: t("{provider} includes this server.", { provider: providerName }),
      };
  }
}

function ServerRow(props: {
  readonly server: ProviderMcpServer;
  readonly providerName: string;
  readonly actions: ReactNode;
}) {
  const { server } = props;
  const badge = originBadge(server, props.providerName);
  return (
    <li className="flex min-w-0 items-start gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate font-medium text-sm">{serverLabel(server)}</span>
          {badge ? (
            <Tooltip>
              <TooltipTrigger render={<Badge size="sm" variant="outline" />}>
                {badge.label}
              </TooltipTrigger>
              <TooltipPopup>{badge.hint}</TooltipPopup>
            </Tooltip>
          ) : null}
          <ServerStatus server={server} />
        </div>
        {server.target ? (
          <p className="truncate font-mono text-muted-foreground text-xs">{server.target}</p>
        ) : null}
        {server.message ? (
          <p
            className={`line-clamp-2 text-xs ${
              server.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground"
            }`}
          >
            {server.message}
          </p>
        ) : null}
      </div>
      <div className="flex min-h-7 shrink-0 items-center gap-2">{props.actions}</div>
    </li>
  );
}

const EMPTY_FORM: McpServerForm = {
  name: "",
  kind: "remote",
  url: "",
  headers: "",
  command: "",
  env: "",
};

function FieldError(props: { readonly id: string; readonly message: string | undefined }) {
  return props.message ? (
    <p id={props.id} role="alert" className="text-destructive-foreground text-xs">
      {props.message}
    </p>
  ) : null;
}

function AddServerDialog(props: {
  readonly target: ProviderTarget;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAdded: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState<McpServerForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<McpServerFormField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addServer = useAtomCommand(serverEnvironment.addProviderMcpServer, {
    reportFailure: false,
  });
  const providerName = props.target.naming.title;

  const update = (field: McpServerFormField, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setFailure(null);
  };
  const close = (open: boolean) => {
    if (adding) return;
    if (!open) {
      setForm(EMPTY_FORM);
      setErrors({});
      setFailure(null);
    }
    props.onOpenChange(open);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const read = readMcpServerForm(form);
    if (!read.ok) {
      setErrors(read.errors);
      return;
    }
    setAdding(true);
    setFailure(null);
    const result = await addServer({
      environmentId: props.target.environmentId,
      input: { instanceId: props.target.provider.instanceId, name: read.name, server: read.server },
    });
    setAdding(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: t("Added {name}", { name: read.name }),
        description:
          read.server.transport === "http"
            ? t("If it asks you to sign in, choose Sign in on its row.")
            : t("New {provider} sessions start it.", { provider: providerName }),
      });
      setForm(EMPTY_FORM);
      props.onOpenChange(false);
      props.onAdded();
      return;
    }
    setFailure(failureMessage(result, t(FAILURE_FALLBACK)));
  };

  const field = (name: McpServerFormField) => ({
    id: `${id}-${name}`,
    disabled: adding,
    "aria-invalid": errors[name] !== undefined,
    "aria-describedby": `${id}-${name}-hint ${id}-${name}-error`,
  });

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogPopup className="sm:max-w-lg">
        <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{t("Add MCP server")}</DialogTitle>
            <DialogDescription>
              {t("{target} gets the server's tools in new sessions.", {
                target: props.target.label,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-name`}>{t("Name")}</Label>
                <Input
                  {...field("name")}
                  autoFocus
                  placeholder={"context7"}
                  value={form.name}
                  onChange={(event) => update("name", event.currentTarget.value)}
                />
                <p id={`${id}-name-hint`} className="text-muted-foreground text-xs">
                  {t(
                    "Letters, numbers, hyphens, and underscores. {provider} names the server's tools after it.",
                    { provider: providerName },
                  )}
                </p>
                <FieldError id={`${id}-name-error`} message={errors.name} />
              </div>
              <div className="flex flex-col gap-2">
                <span id={`${id}-kind`} className="font-medium text-sm">
                  {t("Type")}
                </span>
                <ToggleGroup
                  aria-labelledby={`${id}-kind`}
                  value={[form.kind]}
                  onValueChange={(next) => {
                    const kind = next[0] as McpServerKind | undefined;
                    // Pressing the chosen type again reports no value; the choice stays.
                    if (kind !== undefined) setForm((current) => ({ ...current, kind }));
                  }}
                >
                  <Toggle value="remote" disabled={adding}>
                    {t("Remote URL")}
                  </Toggle>
                  <Toggle value="local" disabled={adding}>
                    {t("Local command")}
                  </Toggle>
                </ToggleGroup>
              </div>
              {form.kind === "remote" ? (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`${id}-url`}>{"URL"}</Label>
                    <Input
                      {...field("url")}
                      type="url"
                      inputMode="url"
                      placeholder={"https://example.com/mcp"}
                      value={form.url}
                      onChange={(event) => update("url", event.currentTarget.value)}
                    />
                    <p id={`${id}-url-hint`} className="text-muted-foreground text-xs">
                      {t(
                        "The server's MCP endpoint. Servers that sign in with a browser need nothing else.",
                      )}
                    </p>
                    <FieldError id={`${id}-url-error`} message={errors.url} />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`${id}-headers`}>{t("Headers (optional)")}</Label>
                    <Textarea
                      {...field("headers")}
                      size="sm"
                      spellCheck={false}
                      placeholder={"Authorization: Bearer …"}
                      value={form.headers}
                      onChange={(event) => update("headers", event.currentTarget.value)}
                    />
                    <p id={`${id}-headers-hint`} className="text-muted-foreground text-xs">
                      {t(
                        "One per line, as Name: value, for servers that take an API key. {provider} keeps them in its config file.",
                        { provider: providerName },
                      )}
                    </p>
                    <FieldError id={`${id}-headers-error`} message={errors.headers} />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`${id}-command`}>{t("Command")}</Label>
                    <Input
                      {...field("command")}
                      spellCheck={false}
                      placeholder={"npx -y @upstash/context7-mcp"}
                      value={form.command}
                      onChange={(event) => update("command", event.currentTarget.value)}
                    />
                    <p id={`${id}-command-hint`} className="text-muted-foreground text-xs">
                      {t(
                        "The command and its arguments. It runs on the machine {provider} runs on.",
                        { provider: providerName },
                      )}
                    </p>
                    <FieldError id={`${id}-command-error`} message={errors.command} />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`${id}-env`}>{t("Environment variables (optional)")}</Label>
                    <Textarea
                      {...field("env")}
                      size="sm"
                      spellCheck={false}
                      placeholder={"API_KEY=…"}
                      value={form.env}
                      onChange={(event) => update("env", event.currentTarget.value)}
                    />
                    <p id={`${id}-env-hint`} className="text-muted-foreground text-xs">
                      {t("One per line, as NAME=value. {provider} keeps them in its config file.", {
                        provider: providerName,
                      })}
                    </p>
                    <FieldError id={`${id}-env-error`} message={errors.env} />
                  </div>
                </>
              )}
              {failure ? (
                <Alert variant="error">
                  <AlertDescription>{failure}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={adding} onClick={() => close(false)}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={adding}>
              {adding ? <Spinner /> : null}
              {t("Add server")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Mounted only while open: the server keeps the sign-in alive as long as this subscribes. */
function SignInFlow(props: {
  readonly target: ProviderTarget;
  readonly server: ProviderMcpServer;
  readonly onClose: () => void;
}) {
  const { target, server } = props;
  const id = useId();
  const signIn = useEnvironmentQuery(
    serverEnvironment.providerMcpSignIn({
      environmentId: target.environmentId,
      input: { instanceId: target.provider.instanceId, name: server.name },
    }),
  );
  const completeSignIn = useAtomCommand(serverEnvironment.completeProviderMcpSignIn, {
    reportFailure: false,
  });
  const [callbackUrl, setCallbackUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const state = signIn.data;
  const providerName = target.naming.title;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!state || !callbackUrl.trim()) {
      setCallbackError(t("Paste the address from the browser's address bar."));
      return;
    }
    setSubmitting(true);
    setCallbackError(null);
    const result = await completeSignIn({
      environmentId: target.environmentId,
      input: {
        instanceId: target.provider.instanceId,
        flowId: state.flowId,
        callbackUrl: callbackUrl.trim(),
      },
    });
    setSubmitting(false);
    if (result._tag !== "Success") setCallbackError(failureMessage(result, t(FAILURE_FALLBACK)));
  };

  if (signIn.error !== null) {
    return (
      <>
        <DialogPanel>
          <Alert variant="error">
            <AlertDescription>{signIn.error}</AlertDescription>
          </Alert>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            {t("Close")}
          </Button>
        </DialogFooter>
      </>
    );
  }
  if (state?.phase === "succeeded") {
    return (
      <>
        <DialogPanel>
          <p className="inline-flex items-center gap-2 text-sm" role="status">
            <CircleCheckIcon className="size-4 text-success-foreground" aria-hidden />
            {t("Signed in. New {provider} sessions can use its tools.", {
              provider: providerName,
            })}
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button onClick={props.onClose}>{t("Done")}</Button>
        </DialogFooter>
      </>
    );
  }
  if (!state) {
    return (
      <DialogPanel>
        <p className="inline-flex items-center gap-2 text-muted-foreground text-sm" role="status">
          <Spinner size="sm" tone="muted" />
          {t("Starting the sign-in…")}
        </p>
      </DialogPanel>
    );
  }
  const authorizationUrl = state.authorizationUrl;
  return (
    <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)}>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {authorizationUrl ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm">
                {t(
                  "Open the sign-in page and approve access. This dialog finishes on its own once {provider} gets the response.",
                  { provider: providerName },
                )}
              </p>
              <Button
                type="button"
                className="self-start"
                onClick={() => openInBrowser(authorizationUrl)}
              >
                {t("Open sign-in page")}
                <ExternalLinkIcon />
              </Button>
            </div>
          ) : null}
          <p className="inline-flex items-center gap-2 text-muted-foreground text-xs" role="status">
            <Spinner size="sm" tone="muted" />
            {t("Waiting for approval…")}
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-callback`}>{t("Redirect address")}</Label>
            <Input
              id={`${id}-callback`}
              spellCheck={false}
              placeholder={"http://localhost:…/callback?code=…"}
              value={callbackUrl}
              disabled={submitting}
              aria-invalid={callbackError !== null}
              aria-describedby={`${id}-callback-hint`}
              onChange={(event) => {
                setCallbackUrl(event.currentTarget.value);
                setCallbackError(null);
              }}
            />
            <p id={`${id}-callback-hint`} className="text-muted-foreground text-xs">
              {t(
                "Signing in on another device, or did the browser show a connection error after you approved? Paste the address from its address bar.",
              )}
            </p>
            {callbackError ? (
              <p role="alert" className="text-destructive-foreground text-xs">
                {callbackError}
              </p>
            ) : null}
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={submitting} onClick={props.onClose}>
          {t("Cancel")}
        </Button>
        <Button type="submit" variant="outline" disabled={submitting || !callbackUrl.trim()}>
          {submitting ? <Spinner /> : null}
          {t("Finish sign-in")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function SignInDialog(props: {
  readonly target: ProviderTarget;
  readonly server: ProviderMcpServer | null;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={props.server !== null} onOpenChange={(open) => (open ? null : props.onClose())}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("Sign in to {server}", {
              server: props.server ? serverLabel(props.server) : t("MCP server"),
            })}
          </DialogTitle>
          <DialogDescription>
            {t("{provider} keeps the sign-in and uses it in new sessions.", {
              provider: props.target.naming.title,
            })}
          </DialogDescription>
        </DialogHeader>
        {props.server ? (
          <SignInFlow target={props.target} server={props.server} onClose={props.onClose} />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

const matchesFilter = (server: ProviderMcpServer, needle: string) =>
  needle === "" ||
  [server.name, server.displayName, server.target].some((field) =>
    field?.toLowerCase().includes(needle),
  );

/** One provider's servers. Every provider on the machine loads at once, so none waits on a switch. */
function ProviderMcpSection(props: {
  readonly target: ProviderTarget;
  readonly needle: string;
  readonly canManage: boolean;
}) {
  const { target, needle, canManage } = props;
  const { environmentId } = target;
  const instanceId = target.provider.instanceId;
  const providerName = target.naming.title;
  const headingId = useId();
  const servers = useEnvironmentQuery(
    serverEnvironment.providerMcpServers({ environmentId, input: { instanceId } }),
  );
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [signingIn, setSigningIn] = useState<ProviderMcpServer | null>(null);
  const navigate = useNavigate();

  const remove = useAtomCommand(serverEnvironment.removeProviderMcpServer, {
    reportFailure: false,
  });
  const signOut = useAtomCommand(serverEnvironment.signOutProviderMcpServer, {
    reportFailure: false,
  });
  const reload = useAtomCommand(serverEnvironment.refreshProviderMcpServers, {
    reportFailure: false,
  });

  // Commands settle with a result instead of rejecting, so the row always clears.
  const track = async <A,>(name: string, run: () => Promise<A>) => {
    setPending((current) => new Set(current).add(name));
    const outcome = await run();
    setPending((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    return outcome;
  };

  const handleRemove = async (server: ProviderMcpServer) => {
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        [
          t("Remove {server} from {provider}?", {
            server: serverLabel(server),
            provider: providerName,
          }),
          t("Its URL or command, and any keys you gave it, are deleted from the config."),
        ].join("\n"),
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    const outcome = await track(server.name, () =>
      remove({ environmentId, input: { instanceId, name: server.name } }),
    );
    if (outcome._tag !== "Success") {
      reportFailure(
        t("Could not remove {server}", { server: serverLabel(server) }),
        outcome,
        t(FAILURE_FALLBACK),
      );
      return;
    }
    servers.refresh();
    toastManager.add({
      type: "success",
      title: t("Removed {server}", { server: serverLabel(server) }),
    });
  };
  const handleSignOut = async (server: ProviderMcpServer) => {
    const outcome = await track(server.name, () =>
      signOut({ environmentId, input: { instanceId, name: server.name } }),
    );
    if (outcome._tag !== "Success") {
      reportFailure(
        t("Could not sign out of {server}", { server: serverLabel(server) }),
        outcome,
        t(FAILURE_FALLBACK),
      );
      return;
    }
    servers.refresh();
    toastManager.add({
      type: "success",
      title: t("Signed out of {server}", { server: serverLabel(server) }),
    });
  };
  const handleRefresh = async () => {
    setRefreshing(true);
    const outcome = await reload({ environmentId, input: { instanceId, refresh: true } });
    setRefreshing(false);
    if (outcome._tag === "Success") servers.refresh();
    else
      reportFailure(
        t("Could not check {provider}'s MCP servers", { provider: providerName }),
        outcome,
        t(FAILURE_FALLBACK),
      );
  };

  const actions = (server: ProviderMcpServer) => {
    const busy = pending.has(server.name);
    return (
      <>
        {busy ? <Spinner size="sm" tone="muted" /> : null}
        {server.status === "notConfigured" ? (
          <Button
            size="compact"
            variant="outline"
            aria-label={t("Connect {server} on claude.ai", { server: serverLabel(server) })}
            onClick={() => {
              void readLocalApi()
                ?.shell.openExternal(CLAUDE_CONNECTORS_URL)
                .catch(() => undefined);
            }}
          >
            {t("Connect on claude.ai")}
            <ExternalLinkIcon aria-hidden />
          </Button>
        ) : null}
        {server.missingVariable ? (
          <Button
            size="compact"
            variant="outline"
            disabled={!canManage}
            aria-label={t("Add {variable} to {provider}", {
              variable: server.missingVariable,
              provider: providerName,
            })}
            onClick={() =>
              void navigate({ to: "/settings/providers", search: { environmentId, instanceId } })
            }
          >
            {t("Add variable")}
          </Button>
        ) : null}
        {server.canSignIn ? (
          <Button
            size="compact"
            variant="outline"
            disabled={!canManage || busy}
            aria-label={t("Sign in to {server}", { server: serverLabel(server) })}
            onClick={() => setSigningIn(server)}
          >
            {t("Sign in")}
          </Button>
        ) : null}
        {server.canSignOut ? (
          <Button
            size="compact"
            variant="ghost"
            disabled={!canManage || busy}
            aria-label={t("Sign out of {server}", { server: serverLabel(server) })}
            onClick={() => void handleSignOut(server)}
          >
            {t("Sign out")}
          </Button>
        ) : null}
        {server.removable ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label={t("Remove {server}", { server: serverLabel(server) })}
                  disabled={!canManage || busy}
                  onClick={() => void handleRemove(server)}
                >
                  <Trash2Icon />
                </Button>
              }
            />
            <TooltipPopup>{t("Remove")}</TooltipPopup>
          </Tooltip>
        ) : null}
      </>
    );
  };

  const result = servers.data;
  const visibleServers = result?.servers.filter((server) => matchesFilter(server, needle)) ?? [];
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        <h2 id={headingId} className="flex min-w-0 items-center gap-2 font-medium text-sm">
          <ProviderTargetIcon target={target} />
          <span className="truncate">{providerName}</span>
        </h2>
        <ProviderTargetAccounts target={target} />
        {result ? (
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            {needle === "" || result.servers.length === 0
              ? result.servers.length
              : t("{shown} of {total}", {
                  shown: visibleServers.length,
                  total: result.servers.length,
                })}
          </span>
        ) : null}
        {servers.isPending && result !== null ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
            <Spinner size="sm" tone="muted" />
            {t("Checking…")}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("Check {provider}'s MCP servers again", { provider: providerName })}
                  disabled={refreshing}
                  onClick={() => void handleRefresh()}
                >
                  {refreshing ? <Spinner /> : <RefreshCwIcon />}
                </Button>
              }
            />
            <TooltipPopup>{t("Connect to every server again")}</TooltipPopup>
          </Tooltip>
          <Button
            size="sm"
            variant="outline"
            aria-label={t("Add MCP server to {provider}", { provider: providerName })}
            disabled={!canManage}
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
            <span className="max-sm:sr-only">{t("Add server")}</span>
          </Button>
        </div>
      </div>
      {result === null && servers.error !== null ? (
        <Alert variant="error">
          <AlertDescription>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{servers.error}</span>
              <Button size="compact" variant="outline" onClick={() => servers.refresh()}>
                {t("Try again")}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : result === null ? (
        <ProviderListSkeleton
          label={t("Loading {provider}'s MCP servers", { provider: providerName })}
        />
      ) : result.servers.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
          {t("No MCP servers yet. Add one to give {provider} new tools.", {
            provider: providerName,
          })}
        </p>
      ) : visibleServers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("No {provider} servers match.", { provider: providerName })}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {visibleServers.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              providerName={providerName}
              actions={actions(server)}
            />
          ))}
        </ul>
      )}
      <AddServerDialog
        target={target}
        open={adding}
        onOpenChange={setAdding}
        onAdded={() => servers.refresh()}
      />
      <SignInDialog
        target={target}
        server={signingIn}
        onClose={() => {
          setSigningIn(null);
          servers.refresh();
        }}
      />
    </section>
  );
}

function McpMachineServers(props: {
  readonly machine: ProviderTargetMachine;
  readonly needle: string;
}) {
  const { machine } = props.machine;
  const canManage = useAtomValue(
    serverEnvironment.addProviderMcpServer.permissionAtom(machine.environmentId),
  );
  if (machine.disconnected) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
        {t("{machine} is offline. Its MCP servers show up once it reconnects.", {
          machine: machine.label,
        })}
      </p>
    );
  }
  return (
    <>
      <p className="text-muted-foreground text-xs">
        {t(
          "MCP servers give agents tools from other apps and services. New sessions load changes; running ones keep the servers they started with.",
        )}
        {canManage ? null : ` ${t("Changing servers needs permission to manage providers.")}`}
      </p>
      {props.machine.targets.map((target) => (
        <ProviderMcpSection
          key={target.key}
          target={target}
          needle={props.needle}
          canManage={canManage}
        />
      ))}
    </>
  );
}

/** The MCP servers tab; its machine picker and search render in `controlsSlot`, the header's right. */
export function McpServersPanel(props: { readonly controlsSlot: HTMLElement | null }) {
  const { machines, machine, selectMachine, connecting } = useProviderTargets("supportsMcpServers");
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const controls: ReactNode = machine ? (
    <>
      <MachinePicker machines={machines} machine={machine} onSelect={selectMachine} />
      <InputGroup className="w-40 sm:w-56">
        <InputGroupAddon>
          <SearchIcon aria-hidden className="size-3" />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label={t("Search MCP servers")}
          placeholder={t("Search servers")}
          size="sm"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || filter.length === 0) return;
            event.preventDefault();
            setFilter("");
          }}
        />
      </InputGroup>
    </>
  ) : null;

  return (
    <>
      {controls && props.controlsSlot ? createPortal(controls, props.controlsSlot) : null}
      {machine ? (
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            <McpMachineServers
              key={machine.machine.environmentId}
              machine={machine}
              needle={needle}
            />
          </WorkspacePageContainer>
        </ScrollArea>
      ) : connecting ? (
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            <ProviderListSkeleton label={t("Loading MCP servers")} />
          </WorkspacePageContainer>
        </ScrollArea>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ServerIcon />
            </EmptyMedia>
            <EmptyTitle>{t("No provider manages MCP servers here")}</EmptyTitle>
            <EmptyDescription>
              {t(
                "Claude and Codex keep their own MCP servers. Turn one on in Settings to add servers and sign in to them here.",
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  );
}
