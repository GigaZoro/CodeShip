import type {
  MonitoringBreakdownRow,
  MonitoringPhaseTotal,
} from "@t3tools/client-runtime/monitoring";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatCount, formatPercent, formatUsd } from "@t3tools/shared/usageFormat";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { MonitoringTruncated } from "./MonitoringSection";
import { PHASE_LABEL } from "@t3tools/client-runtime/monitoring-text";
import { t } from "~/i18n";

const NUMBER_CELL = "text-right";

/** Command phases across the chats shown. */
export function MonitoringPhaseTable({
  phases,
}: {
  readonly phases: ReadonlyArray<MonitoringPhaseTotal>;
}) {
  if (phases.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("No commands ran.")}</p>;
  }
  return (
    <div className="tabular-nums">
      <Table aria-label={t("Steps")}>
        <TableHeader>
          <TableRow>
            <TableHead>{t("Step")}</TableHead>
            <TableHead className={NUMBER_CELL}>{t("Runs")}</TableHead>
            <TableHead className={NUMBER_CELL}>{t("Failure rate")}</TableHead>
            <TableHead className={NUMBER_CELL}>{t("Total time")}</TableHead>
            <TableHead className={NUMBER_CELL}>{t("Average time")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {phases.map((phase) => (
            <TableRow key={phase.phase}>
              <TableCell>{t(PHASE_LABEL[phase.phase])}</TableCell>
              <TableCell className={NUMBER_CELL}>{formatCount(phase.count)}</TableCell>
              <TableCell className={NUMBER_CELL}>{formatPercent(phase.failureRate, 0)}</TableCell>
              <TableCell className={NUMBER_CELL}>{formatDuration(phase.durationMs)}</TableCell>
              <TableCell className={NUMBER_CELL}>{formatDuration(phase.averageMs)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function MonitoringBreakdownTable({
  caption,
  dimension,
  rows,
  labelOf,
}: {
  readonly caption: string;
  /** The first column's heading. */
  readonly dimension: string;
  readonly rows: ReadonlyArray<MonitoringBreakdownRow>;
  readonly labelOf: (key: string) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="tabular-nums">
      <Table aria-label={caption}>
        <TableHeader>
          <TableRow>
            <TableHead>{dimension}</TableHead>
            <TableHead className={NUMBER_CELL}>{t("Chats")}</TableHead>
            <TableHead className={NUMBER_CELL}>{t("Median lifetime")}</TableHead>
            <TableHead className={NUMBER_CELL}>{t("Median active")}</TableHead>
            <TableHead className={NUMBER_CELL}>{t("Cost")}</TableHead>
            <TableHead className={NUMBER_CELL}>{t("Findings")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="max-w-56">
                <MonitoringTruncated text={labelOf(row.key)} />
              </TableCell>
              <TableCell className={NUMBER_CELL}>{formatCount(row.chats)}</TableCell>
              <TableCell className={NUMBER_CELL}>{formatDuration(row.medianLifetimeMs)}</TableCell>
              <TableCell className={NUMBER_CELL}>{formatDuration(row.medianActiveMs)}</TableCell>
              <TableCell className={NUMBER_CELL}>{formatUsd(row.costUsd)}</TableCell>
              <TableCell className={NUMBER_CELL}>{formatCount(row.findings)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
