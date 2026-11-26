import { msg, t } from "~/i18n";
import { CheckIcon, CopyIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";

import { Button } from "./ui/button";

export function CommandBlock({
  command,
  className,
  prominent = false,
  wrap = false,
}: {
  readonly command: string;
  readonly className?: string;
  readonly prominent?: boolean;
  /** Shows a long command in full instead of cutting it off. */
  readonly wrap?: boolean;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: {
      target: "command",
      unavailableMessage: msg("Clipboard API is unavailable while copying command."),
      failureMessage: msg("Failed to copy command to the clipboard."),
    },
  });
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/50 font-mono",
        prominent ? "px-4 py-3.5 text-base" : "px-3 py-2.5 text-sm",
        wrap && "items-start",
        className,
      )}
    >
      <span className={cn("min-w-0", wrap ? "break-all whitespace-pre-wrap" : "truncate")}>
        <span className="mr-2 text-muted-foreground">$</span>
        {command}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t("Copy command")}
        onClick={() => copyToClipboard(command, undefined)}
      >
        {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}
