import {
  PROVIDER_PLUGINS_PAGE_SIZE,
  type ProviderPlugin,
  type ProviderPluginsListResult,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { BlocksIcon, PlusIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";

import { useDeadlinePassed } from "../../hooks/useDeadline";
import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { uniquePluginsById } from "./pluginsPage.logic";
import { failureMessage, reportFailure } from "../extensions/commandFailure";
import {
  ProviderListSkeleton,
  ProviderTargetToggle,
  useProviderTargets,
  type ProviderTarget,
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
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageContainer } from "../WorkspacePageContainer";

const SEARCH_DEBOUNCE_MS = 300;
const installCountFormat = new Intl.NumberFormat(undefined, { notation: "compact" });

const FAILURE_FALLBACK = "The provider could not finish the change.";

const pluginLabel = (plugin: ProviderPlugin) => plugin.displayName ?? plugin.name;

function PluginRow(props: {
  readonly plugin: ProviderPlugin;
  readonly marketplaceLabel: string;
  readonly actions: ReactNode;
}) {
  const { plugin } = props;
  const version = plugin.version
    ? /^\d/.test(plugin.version)
      ? `v${plugin.version}`
      : plugin.version
    : null;
  return (
    <li className="flex min-w-0 items-start gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="min-w-0 truncate font-medium text-sm">{pluginLabel(plugin)}</span>
          {props.marketplaceLabel ? (
            <Badge size="sm" variant="outline">
              {props.marketplaceLabel}
            </Badge>
          ) : null}
          {version ? <span className="text-muted-foreground text-xs">{version}</span> : null}
          {plugin.installCount ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              {installCountFormat.format(plugin.installCount)} installs
            </span>
          ) : null}
        </div>
        {plugin.description ? (
          <p className="line-clamp-2 text-muted-foreground text-xs">{plugin.description}</p>
        ) : null}
      </div>
      <div className="flex min-h-7 shrink-0 items-center gap-2">{props.actions}</div>
    </li>
  );
}

function AddMarketplaceDialog(props: {
  readonly target: ProviderTarget;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAdded: () => void;
}) {
  const sourceId = useId();
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addMarketplace = useAtomCommand(serverEnvironment.addProviderPluginMarketplace, {
    reportFailure: false,
  });
  const close = (open: boolean) => {
    if (adding) return;
    if (!open) {
      setSource("");
      setError(null);
    }
    props.onOpenChange(open);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = source.trim();
    if (!trimmed) {
      setError("Enter a GitHub repository, a git URL, or a folder path.");
      return;
    }
    setAdding(true);
    setError(null);
    const result = await addMarketplace({
      environmentId: props.target.environmentId,
      input: { instanceId: props.target.provider.instanceId, source: trimmed },
    });
    setAdding(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: `Added ${result.value.marketplace}`,
        description: "Its plugins are listed under Available.",
      });
      setSource("");
      props.onOpenChange(false);
      props.onAdded();
      return;
    }
    setError(failureMessage(result, FAILURE_FALLBACK));
  };

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogPopup className="sm:max-w-md">
        <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Add marketplace</DialogTitle>
            <DialogDescription>
              {props.target.label} lists the plugins the marketplace offers, ready to install.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              <Label htmlFor={sourceId}>Source</Label>
              <Input
                id={sourceId}
                autoFocus
                placeholder="owner/repo"
                value={source}
                maxLength={2048}
                disabled={adding}
                aria-invalid={error !== null}
                aria-describedby={`${sourceId}-hint`}
                onChange={(event) => {
                  setSource(event.currentTarget.value);
                  setError(null);
                }}
              />
              <p id={`${sourceId}-hint`} className="text-muted-foreground text-xs">
                A GitHub repository, a git or https URL, or a folder path on the machine{" "}
                {props.target.naming.title} runs on.
              </p>
              {error ? (
                <p role="alert" className="text-destructive-foreground text-xs">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={adding} onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={adding}>
              {adding ? <Spinner /> : null}
              Add marketplace
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function ProviderPluginsPanel(props: { readonly target: ProviderTarget }) {
  const { target } = props;
  const { environmentId } = target;
  const instanceId = target.provider.instanceId;
  const providerName = target.naming.title;
  const canManage = useAtomValue(
    serverEnvironment.installProviderPlugin.permissionAtom(environmentId),
  );
  const [search, setSearch] = useState<{
    readonly text: string;
    readonly submitted: string;
    readonly typedAt: number | null;
  }>({ text: "", submitted: "", typedAt: null });
  const typingSettled = useDeadlinePassed(
    search.typedAt === null ? null : search.typedAt + SEARCH_DEBOUNCE_MS,
  );
  const query = typingSettled ? search.text.trim() : search.submitted;
  const [paging, setPaging] = useState({ query: "", limit: PROVIDER_PLUGINS_PAGE_SIZE });
  const limit = paging.query === query ? paging.limit : PROVIDER_PLUGINS_PAGE_SIZE;
  const plugins = useEnvironmentQuery(
    serverEnvironment.providerPlugins({ environmentId, input: { instanceId, query, limit } }),
  );
  // Keep the last list on screen while the next search or page loads.
  const [lastResult, setLastResult] = useState<ProviderPluginsListResult | null>(null);
  if (plugins.data !== null && plugins.data !== lastResult) setLastResult(plugins.data);
  const result = plugins.data ?? lastResult;
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [addingMarketplace, setAddingMarketplace] = useState(false);

  const install = useAtomCommand(serverEnvironment.installProviderPlugin, { reportFailure: false });
  const uninstall = useAtomCommand(serverEnvironment.uninstallProviderPlugin, {
    reportFailure: false,
  });
  const setEnabled = useAtomCommand(serverEnvironment.setProviderPluginEnabled, {
    reportFailure: false,
  });
  const reload = useAtomCommand(serverEnvironment.refreshProviderPlugins, { reportFailure: false });

  const installed = result === null ? [] : uniquePluginsById(result.installed);
  const marketplaceLabels = new Map(
    (result?.marketplaces ?? []).map((marketplace) => [
      marketplace.name,
      marketplace.displayName ?? marketplace.name,
    ]),
  );
  const marketplaceLabel = (plugin: ProviderPlugin) =>
    marketplaceLabels.get(plugin.marketplace) ?? plugin.marketplace;

  // Commands settle with a result instead of rejecting, so the row always clears.
  const track = async <A,>(pluginId: string, run: () => Promise<A>) => {
    setPending((current) => new Set(current).add(pluginId));
    const outcome = await run();
    setPending((current) => {
      const next = new Set(current);
      next.delete(pluginId);
      return next;
    });
    return outcome;
  };

  const handleInstall = async (plugin: ProviderPlugin) => {
    const outcome = await track(plugin.id, () =>
      install({ environmentId, input: { instanceId, pluginId: plugin.id } }),
    );
    if (outcome._tag !== "Success") {
      reportFailure(`Could not install ${pluginLabel(plugin)}`, outcome, FAILURE_FALLBACK);
      return;
    }
    plugins.refresh();
    const apps = outcome.value.appsNeedingAuth;
    const connectable = apps.find((app) => app.installUrl !== undefined);
    toastManager.add({
      type: "success",
      title: `Installed ${pluginLabel(plugin)}`,
      description:
        apps.length === 0
          ? `New ${providerName} sessions load it.`
          : `Connect ${apps.map((app) => app.name).join(", ")} before using it.`,
      ...(connectable?.installUrl
        ? {
            timeout: 0,
            actionProps: {
              children: `Connect ${connectable.name}`,
              onClick: () => {
                void readLocalApi()
                  ?.shell.openExternal(connectable.installUrl ?? "")
                  .catch(() => undefined);
              },
            },
          }
        : {}),
    });
  };
  const handleUninstall = async (plugin: ProviderPlugin) => {
    const outcome = await track(plugin.id, () =>
      uninstall({ environmentId, input: { instanceId, pluginId: plugin.id } }),
    );
    if (outcome._tag !== "Success") {
      reportFailure(`Could not uninstall ${pluginLabel(plugin)}`, outcome, FAILURE_FALLBACK);
      return;
    }
    plugins.refresh();
    toastManager.add({ type: "success", title: `Uninstalled ${pluginLabel(plugin)}` });
  };
  const handleSetEnabled = async (plugin: ProviderPlugin, enabled: boolean) => {
    const outcome = await track(plugin.id, () =>
      setEnabled({ environmentId, input: { instanceId, pluginId: plugin.id, enabled } }),
    );
    if (outcome._tag !== "Success") {
      reportFailure(
        `Could not ${enabled ? "enable" : "disable"} ${pluginLabel(plugin)}`,
        outcome,
        FAILURE_FALLBACK,
      );
      return;
    }
    plugins.refresh();
  };
  const handleRefresh = async () => {
    setRefreshing(true);
    const outcome = await reload({
      environmentId,
      input: { instanceId, query, limit, refresh: true },
    });
    setRefreshing(false);
    if (outcome._tag === "Success") plugins.refresh();
    else reportFailure("Could not refresh plugins", outcome, FAILURE_FALLBACK);
  };

  const installedActions = (plugin: ProviderPlugin) => {
    const busy = pending.has(plugin.id);
    return (
      <>
        {busy ? <Spinner size="sm" tone="muted" /> : null}
        <Switch
          size="sm"
          checked={plugin.enabled}
          disabled={!canManage || busy}
          aria-label={`Enable ${pluginLabel(plugin)}`}
          onCheckedChange={(enabled) => void handleSetEnabled(plugin, enabled)}
        />
        {plugin.removable ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label={`Uninstall ${pluginLabel(plugin)}`}
                  disabled={!canManage || busy}
                  onClick={() => void handleUninstall(plugin)}
                >
                  <Trash2Icon />
                </Button>
              }
            />
            <TooltipPopup>Uninstall</TooltipPopup>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger render={<Badge size="sm" variant="outline" />}>Managed</TooltipTrigger>
            <TooltipPopup>{providerName} keeps this plugin installed.</TooltipPopup>
          </Tooltip>
        )}
      </>
    );
  };
  const availableActions = (plugin: ProviderPlugin) => {
    const busy = pending.has(plugin.id);
    return (
      <Button
        size="compact"
        variant="outline"
        disabled={!canManage || busy}
        aria-label={`Install ${pluginLabel(plugin)}`}
        onClick={() => void handleInstall(plugin)}
      >
        {busy ? <Spinner /> : null}
        Install
      </Button>
    );
  };

  const searchLabel = `Search ${providerName} plugins`;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <InputGroup className="min-w-0 flex-1">
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label={searchLabel}
              placeholder={searchLabel}
              value={search.text}
              onChange={(event) =>
                setSearch({
                  text: event.currentTarget.value,
                  submitted: query,
                  typedAt: Date.now(),
                })
              }
            />
          </InputGroup>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="Refresh plugins"
                  disabled={refreshing}
                  onClick={() => void handleRefresh()}
                >
                  {refreshing ? <Spinner /> : <RefreshCwIcon />}
                </Button>
              }
            />
            <TooltipPopup>Read the marketplaces again</TooltipPopup>
          </Tooltip>
          <Button
            variant="outline"
            aria-label="Add marketplace"
            disabled={!canManage}
            onClick={() => setAddingMarketplace(true)}
          >
            <PlusIcon />
            <span className="hidden sm:inline">Add marketplace</span>
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Plugins add skills, commands, agents, hooks, and MCP servers to {providerName}. New
          sessions load changes; running ones keep what they started with.
          {canManage ? null : " Changing plugins needs permission to manage providers."}
        </p>
      </div>

      {result === null && plugins.error !== null ? (
        <Alert variant="error">
          <AlertDescription>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{plugins.error}</span>
              <Button size="compact" variant="outline" onClick={() => plugins.refresh()}>
                Try again
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : result === null ? (
        <ProviderListSkeleton label="Loading plugins" />
      ) : (
        <>
          {result.warnings.length > 0 ? (
            <Alert variant="warning">
              <AlertDescription>
                <ul className="flex flex-col gap-1">
                  {result.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          <section
            aria-labelledby={`plugins-installed-${target.key}`}
            className="flex flex-col gap-2"
          >
            <h2
              id={`plugins-installed-${target.key}`}
              className="flex items-center gap-2 font-medium text-sm"
            >
              Installed
              <span className="text-muted-foreground text-xs tabular-nums">{installed.length}</span>
            </h2>
            {installed.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {query ? `No installed plugins match “${query}”.` : "No plugins installed yet."}
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {installed.map((plugin) => (
                  <PluginRow
                    key={plugin.id}
                    plugin={plugin}
                    marketplaceLabel={marketplaceLabel(plugin)}
                    actions={installedActions(plugin)}
                  />
                ))}
              </ul>
            )}
          </section>
          <section
            aria-labelledby={`plugins-available-${target.key}`}
            className="flex flex-col gap-2"
          >
            <h2
              id={`plugins-available-${target.key}`}
              className="flex items-center gap-2 font-medium text-sm"
            >
              Available
              <span className="text-muted-foreground text-xs tabular-nums">
                {result.availableTotal}
              </span>
              {plugins.isPending ? <Spinner size="sm" tone="muted" /> : null}
            </h2>
            {result.available.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {query
                  ? `No plugins to install match “${query}”.`
                  : "Every plugin your marketplaces offer is installed. Add a marketplace to find more."}
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {result.available.map((plugin) => (
                  <PluginRow
                    key={plugin.id}
                    plugin={plugin}
                    marketplaceLabel={marketplaceLabel(plugin)}
                    actions={availableActions(plugin)}
                  />
                ))}
              </ul>
            )}
            {result.availableTotal > result.available.length ? (
              <Button
                variant="outline"
                className="self-center"
                disabled={plugins.isPending}
                onClick={() => setPaging({ query, limit: limit + PROVIDER_PLUGINS_PAGE_SIZE })}
              >
                Show more
              </Button>
            ) : null}
          </section>
        </>
      )}
      <AddMarketplaceDialog
        target={target}
        open={addingMarketplace}
        onOpenChange={setAddingMarketplace}
        onAdded={() => plugins.refresh()}
      />
    </div>
  );
}

export function PluginsPanel() {
  const { targets, target, setSelectedKey, connecting } = useProviderTargets("supportsPlugins");
  if (connecting) {
    return (
      <ScrollArea className="min-h-0 flex-1">
        <WorkspacePageContainer width="wide">
          <ProviderListSkeleton label="Loading plugins" />
        </WorkspacePageContainer>
      </ScrollArea>
    );
  }
  if (target === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BlocksIcon />
          </EmptyMedia>
          <EmptyTitle>No provider installs plugins here</EmptyTitle>
          <EmptyDescription>
            Claude, Codex, and Grok install plugins from their marketplaces. Turn one on in Settings
            to browse and install them here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <WorkspacePageContainer width="wide">
        <ProviderTargetToggle targets={targets} target={target} onSelect={setSelectedKey} />
        <ProviderPluginsPanel key={target.key} target={target} />
      </WorkspacePageContainer>
    </ScrollArea>
  );
}
