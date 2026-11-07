import type { ReactNode } from "react";
import type { DeviceToolVersions as ToolVersions } from "@t3tools/contracts";
import { InlineButton } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { t } from "~/i18n";

export function DeviceToolVersions({
  tools,
  action,
  kind,
  owner,
  error,
}: {
  tools: ToolVersions | undefined;
  action?: ReactNode;
  kind?: keyof ToolVersions;
  owner?: string | undefined;
  error?: string | undefined;
}) {
  const selected = kind ? tools?.[kind] : undefined;
  const version =
    selected?.runningVersion ??
    (selected?.installedVersions.includes(selected.requiredVersion)
      ? selected.requiredVersion
      : selected?.installedVersions
          .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .at(-1));
  const label = kind === "hub" ? t("Device hub") : t("Agent device");
  return (
    <Popover>
      <PopoverTrigger
        aria-label={
          kind
            ? version
              ? t("{label}: version {version}. Show details", { label, version })
              : selected
                ? t("{label}: not installed. Show details", { label })
                : t("{label}: version unknown. Show details", { label })
            : undefined
        }
        render={<InlineButton tone="muted" />}
      >
        {kind
          ? version
            ? `v${version}`
            : selected
              ? t("Not installed")
              : t("Version unknown")
          : error
            ? t("Versions unavailable")
            : t("Versions")}
      </PopoverTrigger>
      <PopoverPopup align="end" width="md">
        <PopoverTitle>{kind ? label : t("Device tools")}</PopoverTitle>
        {tools ? (
          <div className="mt-4 divide-y divide-border/50">
            {(
              [
                ["hub", t("Device hub"), tools.hub],
                ["agent", t("Agent device"), tools.agent],
              ] as const
            )
              .filter(([key]) => !kind || key === kind)
              .map(([key, name, tool]) => (
                <div key={key} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  {!kind ? <p className="text-xs font-medium">{name}</p> : null}
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">{t("Running")}</dt>
                    <dd className="text-right font-mono">
                      {tool.runningVersion ?? t("Not running")}
                    </dd>
                    <dt className="text-muted-foreground">{t("Required")}</dt>
                    <dd className="text-right font-mono">{tool.requiredVersion}</dd>
                    <dt className="text-muted-foreground">{t("Installed")}</dt>
                    <dd className="text-right font-mono break-words">
                      {tool.installedVersions.join(", ") || t("None")}
                    </dd>
                  </dl>
                </div>
              ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            {t("Versions have not been checked.")}
          </p>
        )}
        <p className="mt-4 border-t border-border/50 pt-3 text-xs text-muted-foreground">
          {owner
            ? t("Managed by {owner}. Tools update automatically on this host when needed.", {
                owner,
              })
            : t("Tools update automatically on this host when needed.")}
        </p>
        {error ? (
          <p role="status" className="mt-2 text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </PopoverPopup>
    </Popover>
  );
}
