import {
  EnvironmentId,
  ProviderInstanceId,
  type ProviderMcpServer,
  type ProviderMcpServerSettings,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { mcpRedirect } from "@t3tools/shared/mcpAuthCallback";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  CircleOffIcon,
  ExternalLinkIcon,
  GitCompareArrowsIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { runsOnAnotherComputer } from "../../state/loopbackEnvironment";
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
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
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
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Toggle } from "../ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import {
  mcpServerFormFromSettings,
  readMcpServerEditForm,
  readMcpServerForm,
  type McpServerForm,
  type McpServerFormField,
  type McpServerKind,
} from "./mcpServerForm";
import {
  compareMcpServers,
  type McpPeerServers,
  type McpServerComparison,
  type McpServerDifference,
} from "./mcpServersCompare";
import { msg, t, tn, type Message } from "~/i18n";

const FAILURE_FALLBACK = msg("The provider could not finish the change.");

const serverLabel = (server: ProviderMcpServer) => server.displayName ?? server.name;

const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

const COMPARE_MACHINES_KEY = "t3code:mcp:compare-machines";
const URL_PLACEHOLDER = "https://example.com/mcp";

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

/** Where another machine's copy of the server differs, one machine per line. */
function differenceText(difference: McpServerDifference) {
  const { label, server } = difference;
  if (server.status === "disabled") return t("{machine}: turned off", { machine: label });
  return t("{machine}: {target}", { machine: label, target: server.target ?? t("no address") });
}

function ComparisonBadges(props: { readonly comparison: McpServerComparison | undefined }) {
  const { comparison } = props;
  if (comparison === undefined) return null;
  return (
    <>
      {comparison.missingOn.length > 0 ? (
        <Badge size="sm" variant="warning">
          {t("Not on {machines}", { machines: comparison.missingOn.join(", ") })}
        </Badge>
      ) : null}
      {comparison.differentOn.length > 0 ? (
        <Tooltip>
          <TooltipTrigger render={<Badge size="sm" variant="outline" />}>
            {t("Differs on {machines}", {
              machines: comparison.differentOn.map((difference) => difference.label).join(", "),
            })}
          </TooltipTrigger>
          <TooltipPopup>
            <ul className="flex flex-col gap-0.5">
              {comparison.differentOn.map((difference) => (
                <li key={difference.label}>{differenceText(difference)}</li>
              ))}
            </ul>
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}

function ServerRow(props: {
  readonly server: ProviderMcpServer;
  readonly providerName: string;
  readonly comparison: McpServerComparison | undefined;
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
          <ComparisonBadges comparison={props.comparison} />
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

/** What the server dialog is open for; an edit waits for the stored settings it starts from. */
type ServerDialogRequest =
  | { readonly mode: "add" }
  | {
      readonly mode: "edit";
      readonly server: ProviderMcpServer;
      readonly settings: ProviderMcpServerSettings | null;
      readonly error: string | null;
    };

function ServerDialog(props: {
  readonly target: ProviderTarget;
  readonly request: ServerDialogRequest | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const { request } = props;
  const [busy, setBusy] = useState(false);
  const editing = request?.mode === "edit" ? request : null;
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        {editing === null ? (
          <ServerForm
            key="add"
            target={props.target}
            stored={null}
            initial={EMPTY_FORM}
            onBusyChange={setBusy}
            onClose={props.onClose}
            onSaved={props.onSaved}
          />
        ) : editing.settings !== null ? (
          <ServerForm
            key={`edit:${editing.server.name}`}
            target={props.target}
            stored={{ server: editing.server, settings: editing.settings }}
            initial={mcpServerFormFromSettings(editing.server.name, editing.settings)}
            onBusyChange={setBusy}
            onClose={props.onClose}
            onSaved={props.onSaved}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {t("Edit {server}", { server: serverLabel(editing.server) })}
              </DialogTitle>
            </DialogHeader>
            <DialogPanel>
              {editing.error === null ? (
                <p
                  className="inline-flex items-center gap-2 text-muted-foreground text-sm"
                  role="status"
                >
                  <Spinner size="sm" tone="muted" />
                  {t("Reading its settings…")}
                </p>
              ) : (
                <Alert variant="error">
                  <AlertDescription>{editing.error}</AlertDescription>
                </Alert>
              )}
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={props.onClose}>
                {t("Cancel")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function ServerForm(props: {
  readonly target: ProviderTarget;
  /** The server being edited and its settings, or null when adding one. */
  readonly stored: {
    readonly server: ProviderMcpServer;
    readonly settings: ProviderMcpServerSettings;
  } | null;
  readonly initial: McpServerForm;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const { stored } = props;
  const id = useId();
  const [form, setForm] = useState<McpServerForm>(props.initial);
  const [errors, setErrors] = useState<Partial<Record<McpServerFormField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const addServer = useAtomCommand(serverEnvironment.addProviderMcpServer, {
    reportFailure: false,
  });
  const editServer = useAtomCommand(serverEnvironment.editProviderMcpServer, {
    reportFailure: false,
  });
  const providerName = props.target.naming.title;
  const environmentId = props.target.environmentId;
  const instanceId = props.target.provider.instanceId;
  const keepsUrl =
    stored?.settings.transport === "http" && stored.settings.urlHasSecret && form.kind === "remote";

  const update = (field: McpServerFormField, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setFailure(null);
  };
  const setBusy = (busy: boolean) => {
    setSaving(busy);
    props.onBusyChange(busy);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (stored === null) {
      const read = readMcpServerForm(form);
      if (!read.ok) {
        setErrors(read.errors);
        return;
      }
      setBusy(true);
      setFailure(null);
      const result = await addServer({
        environmentId,
        input: { instanceId, name: read.name, server: read.server },
      });
      setBusy(false);
      if (result._tag !== "Success") {
        setFailure(failureMessage(result, t(FAILURE_FALLBACK)));
        return;
      }
      toastManager.add({
        type: "success",
        title: t("Added {name}", { name: read.name }),
        description:
          read.server.transport === "http"
            ? t("If it asks you to sign in, choose Sign in on its row.")
            : t("New {provider} sessions start it.", { provider: providerName }),
      });
    } else {
      const read = readMcpServerEditForm(form, stored.settings);
      if (!read.ok) {
        setErrors(read.errors);
        return;
      }
      setBusy(true);
      setFailure(null);
      const result = await editServer({
        environmentId,
        input: { instanceId, name: stored.server.name, server: read.server },
      });
      setBusy(false);
      if (result._tag !== "Success") {
        setFailure(failureMessage(result, t(FAILURE_FALLBACK)));
        return;
      }
      toastManager.add({
        type: "success",
        title: t("Saved {name}", { name: serverLabel(stored.server) }),
        description: t("New {provider} sessions use the change.", { provider: providerName }),
      });
    }
    props.onClose();
    props.onSaved();
  };

  const field = (name: McpServerFormField) => ({
    id: `${id}-${name}`,
    disabled: saving,
    "aria-invalid": errors[name] !== undefined,
    "aria-describedby": `${id}-${name}-hint ${id}-${name}-error`,
  });
  const keepHint =
    stored === null
      ? null
      : t("A name with an empty value keeps its stored value. Remove a line to delete it.");

  return (
    <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>
          {stored === null
            ? t("Add MCP server")
            : t("Edit {server}", { server: serverLabel(stored.server) })}
        </DialogTitle>
        <DialogDescription>
          {stored === null
            ? t("{target} gets the server's tools in new sessions.", {
                target: props.target.label,
              })
            : t("New {provider} sessions use the change; running ones keep the old one.", {
                provider: providerName,
              })}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {stored === null ? (
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
          ) : null}
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
              <ToggleGroupItem value="remote" disabled={saving}>
                {t("Remote URL")}
              </ToggleGroupItem>
              <ToggleGroupItem value="local" disabled={saving}>
                {t("Local command")}
              </ToggleGroupItem>
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
                  placeholder={
                    keepsUrl && stored?.settings.transport === "http"
                      ? stored.settings.url
                      : URL_PLACEHOLDER
                  }
                  value={form.url}
                  onChange={(event) => update("url", event.currentTarget.value)}
                />
                <p id={`${id}-url-hint`} className="text-muted-foreground text-xs">
                  {keepsUrl
                    ? t(
                        "The stored address includes a key, so it is not shown. Leave this empty to keep it.",
                      )
                    : t(
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
                  {keepHint ??
                    t(
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
                  {t("The command and its arguments. It runs on the machine {provider} runs on.", {
                    provider: providerName,
                  })}
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
                  {keepHint ??
                    t("One per line, as NAME=value. {provider} keeps them in its config file.", {
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
        <Button type="button" variant="outline" disabled={saving} onClick={props.onClose}>
          {t("Cancel")}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? <Spinner /> : null}
          {stored === null ? t("Add server") : t("Save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Removing deletes what the server needs, so the confirmation offers to turn it off instead. */
function RemoveServerDialog(props: {
  readonly target: ProviderTarget;
  readonly server: ProviderMcpServer | null;
  readonly onClose: () => void;
  readonly onRemove: (server: ProviderMcpServer) => void;
  readonly onTurnOff: (server: ProviderMcpServer) => void;
}) {
  const { server } = props;
  const canTurnOff = server?.canToggle === true && server.status !== "disabled";
  return (
    <AlertDialog
      open={server !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("Remove {server} from {provider}?", {
              server: server ? serverLabel(server) : t("MCP server"),
              provider: props.target.naming.title,
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {canTurnOff
              ? t(
                  "Removing deletes its URL or command and any keys stored with it. To stop using it but keep them, turn it off instead.",
                )
              : t("Removing deletes its URL or command and any keys stored with it.")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>{t("Cancel")}</AlertDialogClose>
          {server && canTurnOff ? (
            <Button
              variant="outline"
              onClick={() => {
                props.onClose();
                props.onTurnOff(server);
              }}
            >
              {t("Turn off instead")}
            </Button>
          ) : null}
          <Button
            variant="destructive"
            onClick={() => {
              props.onClose();
              if (server) props.onRemove(server);
            }}
          >
            {t("Remove")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
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

  const complete = async (flowId: string, address: string) => {
    setSubmitting(true);
    setCallbackError(null);
    const result = await completeSignIn({
      environmentId: target.environmentId,
      input: { instanceId: target.provider.instanceId, flowId, callbackUrl: address },
    });
    setSubmitting(false);
    if (result._tag !== "Success") setCallbackError(failureMessage(result, t(FAILURE_FALLBACK)));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!state || !callbackUrl.trim()) {
      setCallbackError(t("Paste the address from the browser's address bar."));
      return;
    }
    void complete(state.flowId, callbackUrl.trim());
  };

  // The browser returns to a loopback address on this computer. For a provider on another
  // computer, only the desktop app can catch it there; the paste field stays as the fallback.
  const receiving = useRef<string | null>(null);
  const openSignInPage = async (authorizationUrl: string, flowId: string) => {
    const desktop = window.desktopBridge;
    if (
      !desktop ||
      !mcpRedirect(authorizationUrl) ||
      !runsOnAnotherComputer(target.environmentId) ||
      receiving.current === authorizationUrl
    ) {
      openInBrowser(authorizationUrl);
      return;
    }
    receiving.current = authorizationUrl;
    setCallbackError(null);
    let address: string;
    try {
      address = await desktop.receiveMcpAuthCallback(authorizationUrl);
    } catch {
      if (receiving.current === authorizationUrl) {
        receiving.current = null;
        setCallbackError(
          t(
            "Could not finish sign-in on this computer. After you approve, paste the address from the browser's address bar below.",
          ),
        );
      }
      return;
    }
    if (receiving.current !== authorizationUrl) return;
    receiving.current = null;
    await complete(flowId, address);
  };
  const pendingUrl = state?.authorizationUrl;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the desktop callback listener when the authorization URL changes or the dialog unmounts
  useEffect(() => {
    if (!pendingUrl) return;
    return () => {
      if (receiving.current !== pendingUrl) return;
      receiving.current = null;
      void window.desktopBridge?.cancelMcpAuthCallback(pendingUrl).catch(() => undefined);
    };
  }, [pendingUrl]);

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
    <form className="flex min-h-0 flex-col" onSubmit={submit}>
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
                onClick={() => void openSignInPage(authorizationUrl, state.flowId)}
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
                "If the browser shows a connection error after you approve, paste the address from its address bar.",
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

/** Another machine's copy of the same provider, compared row by row when comparing is on. */
interface PeerTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
}

const PeerTargetsKey = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      instanceId: ProviderInstanceId,
      label: Schema.String,
    }),
  ),
);
const encodePeerTargets = Schema.encodeSync(PeerTargetsKey);
const decodePeerTargets = Schema.decodeSync(PeerTargetsKey);

interface PeerServers extends McpPeerServers {
  /** The machine's list has not answered yet. */
  readonly loading: boolean;
  readonly failed: boolean;
}

const NO_PEERS = Atom.make((): ReadonlyArray<PeerServers> => []);

/** Every other machine's list, read together so each row can say where it differs. */
const peerServersAtom = Atom.family((key: string) => {
  const peers = decodePeerTargets(key);
  return Atom.make((get): ReadonlyArray<PeerServers> =>
    peers.map((peer) => {
      const result = get(
        serverEnvironment.providerMcpServers({
          environmentId: peer.environmentId,
          input: { instanceId: peer.instanceId },
        }),
      );
      const servers = AsyncResult.getOrElse(result, () => null)?.servers ?? null;
      return {
        label: peer.label,
        servers,
        loading: servers === null && result._tag === "Initial",
        failed: servers === null && result._tag === "Failure",
      };
    }),
  );
});

/** A switch shows what was asked for until a list fetched after the change arrives. */
interface WantedSwitch {
  readonly enabled: boolean;
  /** The list it was asked over; null while the change is still being made. */
  readonly listAt: number | null;
}

/** One provider's servers. Every provider on the machine loads at once, so none waits on a switch. */
function ProviderMcpSection(props: {
  readonly target: ProviderTarget;
  readonly needle: string;
  readonly canManage: boolean;
  readonly peers: ReadonlyArray<PeerTarget>;
}) {
  const { target, needle, canManage } = props;
  const { environmentId } = target;
  const instanceId = target.provider.instanceId;
  const providerName = target.naming.title;
  const headingId = useId();
  const servers = useEnvironmentQuery(
    serverEnvironment.providerMcpServers({ environmentId, input: { instanceId } }),
  );
  const peerServers = useAtomValue(
    props.peers.length === 0 ? NO_PEERS : peerServersAtom(encodePeerTargets(props.peers)),
  );
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [wanted, setWanted] = useState<ReadonlyMap<string, WantedSwitch>>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [dialog, setDialog] = useState<ServerDialogRequest | null>(null);
  const [removing, setRemoving] = useState<ProviderMcpServer | null>(null);
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
  const readServer = useAtomCommand(serverEnvironment.readProviderMcpServer, {
    reportFailure: false,
  });
  const setServerEnabled = useAtomCommand(serverEnvironment.setProviderMcpServerEnabled, {
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
  const setWantedSwitch = (name: string, next: WantedSwitch | null) =>
    setWanted((current) => {
      const updated = new Map(current);
      if (next === null) updated.delete(name);
      else updated.set(name, next);
      return updated;
    });

  const isOn = (server: ProviderMcpServer) => {
    const asked = wanted.get(server.name);
    return asked !== undefined && (asked.listAt === null || asked.listAt === servers.dataUpdatedAt)
      ? asked.enabled
      : server.status !== "disabled";
  };

  const handleSetEnabled = async (server: ProviderMcpServer, enabled: boolean) => {
    const listAt = servers.dataUpdatedAt;
    setWantedSwitch(server.name, { enabled, listAt: null });
    const outcome = await track(server.name, () =>
      setServerEnabled({ environmentId, input: { instanceId, name: server.name, enabled } }),
    );
    if (outcome._tag !== "Success") {
      setWantedSwitch(server.name, null);
      reportFailure(
        enabled
          ? t("Could not turn on {server}", { server: serverLabel(server) })
          : t("Could not turn off {server}", { server: serverLabel(server) }),
        outcome,
        t(FAILURE_FALLBACK),
      );
      return;
    }
    setWantedSwitch(server.name, { enabled, listAt });
    servers.refresh();
  };
  const handleRemove = async (server: ProviderMcpServer) => {
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
  const handleEdit = async (server: ProviderMcpServer) => {
    setDialog({ mode: "edit", server, settings: null, error: null });
    const outcome = await readServer({ environmentId, input: { instanceId, name: server.name } });
    setDialog((current) =>
      current?.mode !== "edit" || current.server.name !== server.name
        ? current
        : outcome._tag === "Success"
          ? { ...current, settings: outcome.value.server }
          : { ...current, error: failureMessage(outcome, t(FAILURE_FALLBACK)) },
    );
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
    const on = isOn(server);
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
        {server.canSignIn && on ? (
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
        {server.canEdit === true ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t("Edit {server}", { server: serverLabel(server) })}
                  disabled={!canManage || busy}
                  onClick={() => void handleEdit(server)}
                >
                  <PencilIcon />
                </Button>
              }
            />
            <TooltipPopup>{t("Edit")}</TooltipPopup>
          </Tooltip>
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
                  onClick={() => setRemoving(server)}
                >
                  <Trash2Icon />
                </Button>
              }
            />
            <TooltipPopup>{t("Remove")}</TooltipPopup>
          </Tooltip>
        ) : null}
        {server.canToggle === true ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="flex items-center">
                  <Switch
                    size="sm"
                    checked={on}
                    disabled={!canManage || busy}
                    aria-label={t("Enable {name}", { name: serverLabel(server) })}
                    onCheckedChange={(enabled) => void handleSetEnabled(server, enabled)}
                  />
                </span>
              }
            />
            <TooltipPopup>
              {canManage
                ? on
                  ? t("Turn off; its settings are kept")
                  : t("Turn on")
                : t("Changing servers needs permission to manage providers.")}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </>
    );
  };

  const result = servers.data;
  const visibleServers = result?.servers.filter((server) => matchesFilter(server, needle)) ?? [];
  const comparison = result === null ? null : compareMcpServers(result.servers, peerServers);
  const comparing = peerServers.some((peer) => peer.loading);
  const notCompared = peerServers.filter((peer) => peer.failed).map((peer) => peer.label);
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
        ) : comparing ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
            <Spinner size="sm" tone="muted" />
            {t("Comparing…")}
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
            onClick={() => setDialog({ mode: "add" })}
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
              comparison={comparison?.byName.get(server.name)}
              actions={actions(server)}
            />
          ))}
        </ul>
      )}
      {comparison !== null && comparison.onlyElsewhere.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("Missing here: {servers}", {
            servers: comparison.onlyElsewhere
              .map((entry) =>
                t("{server} (on {machines})", {
                  server: entry.name,
                  machines: entry.labels.join(", "),
                }),
              )
              .join(", "),
          })}
        </p>
      ) : null}
      {notCompared.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("Could not read {machines} to compare.", { machines: notCompared.join(", ") })}
        </p>
      ) : null}
      <ServerDialog
        target={target}
        request={dialog}
        onClose={() => setDialog(null)}
        onSaved={() => servers.refresh()}
      />
      <RemoveServerDialog
        target={target}
        server={removing}
        onClose={() => setRemoving(null)}
        onRemove={(server) => void handleRemove(server)}
        onTurnOff={(server) => void handleSetEnabled(server, false)}
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

/** The same provider on each other machine, matched by instance id as the Skills page does. */
function peerTargets(
  target: ProviderTarget,
  others: ReadonlyArray<ProviderTargetMachine>,
): ReadonlyArray<PeerTarget> {
  return others.flatMap((other) =>
    other.targets
      .filter((candidate) => candidate.provider.instanceId === target.provider.instanceId)
      .map((candidate) => ({
        environmentId: candidate.environmentId,
        instanceId: candidate.provider.instanceId,
        label: other.machine.label,
      })),
  );
}

function McpMachineServers(props: {
  readonly machine: ProviderTargetMachine;
  readonly needle: string;
  /** Connected machines to compare with; empty while comparing is off. */
  readonly compareWith: ReadonlyArray<ProviderTargetMachine>;
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
          peers={peerTargets(target, props.compareWith)}
        />
      ))}
    </>
  );
}

/** The MCP servers tab; its machine picker and search render in `controlsSlot`, the header's right. */
export function McpServersPanel(props: { readonly controlsSlot: HTMLElement | null }) {
  const { machines, machine, selectMachine, connecting } = useProviderTargets("supportsMcpServers");
  const [filter, setFilter] = useState("");
  // Each machine's list starts its providers, so comparing waits until asked for.
  const [compare, setCompare] = useLocalStorage(COMPARE_MACHINES_KEY, false, Schema.Boolean);
  const needle = filter.trim().toLowerCase();
  const others = machines.filter(
    (candidate) => candidate !== machine && !candidate.machine.disconnected,
  );
  const controls: ReactNode = machine ? (
    <>
      <MachinePicker machines={machines} machine={machine} onSelect={selectMachine} />
      {others.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                size="sm"
                variant="outline"
                pressed={compare}
                aria-label={t("Compare with other machines")}
                onPressedChange={setCompare}
              />
            }
          >
            <GitCompareArrowsIcon aria-hidden />
            <span className="max-sm:sr-only">{t("Compare")}</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {t("Mark servers another connected machine lacks or sets up differently")}
          </TooltipPopup>
        </Tooltip>
      ) : null}
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
              compareWith={compare ? others : []}
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
