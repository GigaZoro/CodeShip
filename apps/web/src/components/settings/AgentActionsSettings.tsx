import {
  MAX_AGENT_ACTION_LABEL_LENGTH,
  MAX_AGENT_ACTION_PROMPT_LENGTH,
  MAX_CUSTOM_AGENT_ACTIONS,
  type CustomAgentAction,
} from "@t3tools/contracts/settings";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  updateClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
} from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

interface DraftAgentAction {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
}

/** A request needs both a name and its text; one still being written is not saved yet. */
function completeAgentActions(rows: ReadonlyArray<DraftAgentAction>): CustomAgentAction[] {
  return rows.flatMap((row) => {
    const label = row.label.trim();
    const prompt = row.prompt.trim();
    return label.length > 0 && prompt.length > 0 ? [{ id: row.id, label, prompt }] : [];
  });
}

export function AgentActionsSettings() {
  // Seeding the editor before saved settings load would save an empty list over them.
  const hydrated = useClientSettingsHydrated();
  return (
    <SettingsRow
      {...searchableSetting("agent-actions")}
      description="Add your own requests next to Commit & open PR, Run tests and Review changes in the thread details card and the command palette. Each sends its text to the agent as your message, in the order listed here."
    >
      {hydrated ? <AgentActionsEditor /> : null}
    </SettingsRow>
  );
}

function AgentActionsEditor() {
  const saved = useClientSettings((settings) => settings.customAgentActions);
  const [rows, setRows] = useState<ReadonlyArray<DraftAgentAction>>(saved);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const save = (next: ReadonlyArray<DraftAgentAction>) =>
    void updateClientSettings({ customAgentActions: completeAgentActions(next) });
  const edit = (id: string, patch: Partial<Omit<DraftAgentAction, "id">>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const move = (index: number, offset: -1 | 1, arrow: HTMLButtonElement) => {
    const row = rows[index];
    const target = index + offset;
    if (row === undefined || target < 0 || target >= rows.length) return;
    const next = rows.filter((_, candidate) => candidate !== index);
    next.splice(target, 0, row);
    // Reordering re-inserts the row's element, which drops the focus its arrow had.
    flushSync(() => setRows(next));
    arrow.focus();
    save(next);
  };
  const atLimit = rows.length >= MAX_CUSTOM_AGENT_ACTIONS;
  return (
    <div className="mt-3 flex max-w-2xl flex-col gap-3 pb-3.5">
      {rows.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.map((row, index) => (
            <AgentActionEditorRow
              key={row.id}
              row={row}
              first={index === 0}
              last={index === rows.length - 1}
              onEdit={(patch) => edit(row.id, patch)}
              onCommit={() => save(rows)}
              onMove={(offset, arrow) => move(index, offset, arrow)}
              onRemove={() => {
                const next = rows.filter((candidate) => candidate.id !== row.id);
                // The removed row took focus with it; the add button is where the list continues.
                flushSync(() => setRows(next));
                addButtonRef.current?.focus();
                save(next);
              }}
            />
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          ref={addButtonRef}
          size="sm"
          variant="outline"
          disabled={atLimit}
          onClick={() =>
            setRows((current) => [...current, { id: randomUUID(), label: "", prompt: "" }])
          }
        >
          <PlusIcon aria-hidden />
          Add a request
        </Button>
        {atLimit ? (
          <span className="text-xs text-muted-foreground">
            You can add up to {MAX_CUSTOM_AGENT_ACTIONS} requests.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AgentActionEditorRow(props: {
  row: DraftAgentAction;
  first: boolean;
  last: boolean;
  onEdit: (patch: Partial<Omit<DraftAgentAction, "id">>) => void;
  onCommit: () => void;
  onMove: (offset: -1 | 1, arrow: HTMLButtonElement) => void;
  onRemove: () => void;
}) {
  const { row, first, last } = props;
  const labelId = useId();
  const promptId = useId();
  const name = row.label.trim() || "this request";
  const incomplete = row.label.trim().length === 0 || row.prompt.trim().length === 0;
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={labelId}>Button name</Label>
          <Input
            id={labelId}
            size="sm"
            // A new row starts with an empty name, so it takes focus to be filled in.
            autoFocus={row.label.length === 0 && row.prompt.length === 0}
            maxLength={MAX_AGENT_ACTION_LABEL_LENGTH}
            placeholder="Update the docs"
            value={row.label}
            onChange={(event) => props.onEdit({ label: event.currentTarget.value })}
            onBlur={props.onCommit}
          />
        </div>
        {/* aria-disabled keeps keyboard focus on an arrow whose row just reached an end. */}
        <div className="flex items-center gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={`Move ${name} up`}
            aria-disabled={first || undefined}
            onClick={(event) => {
              if (!first) props.onMove(-1, event.currentTarget);
            }}
          >
            <ArrowUpIcon aria-hidden />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={`Move ${name} down`}
            aria-disabled={last || undefined}
            onClick={(event) => {
              if (!last) props.onMove(1, event.currentTarget);
            }}
          >
            <ArrowDownIcon aria-hidden />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={`Remove ${name}`}
            onClick={props.onRemove}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      </div>
      <p className="m-0 -mt-1 text-end text-xs tabular-nums text-muted-foreground">
        {row.label.length} / {MAX_AGENT_ACTION_LABEL_LENGTH}
      </p>
      <div className="flex flex-col gap-1">
        <Label htmlFor={promptId}>Request sent to the agent</Label>
        <Textarea
          id={promptId}
          rows={3}
          maxLength={MAX_AGENT_ACTION_PROMPT_LENGTH}
          placeholder="Update the README and the user docs for the changes in this thread."
          value={row.prompt}
          onChange={(event) => props.onEdit({ prompt: event.currentTarget.value })}
          onBlur={props.onCommit}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span role="status">
          {incomplete ? "Add a name and a request to show this button." : null}
        </span>
        <span className="tabular-nums">
          {row.prompt.length} / {MAX_AGENT_ACTION_PROMPT_LENGTH}
        </span>
      </div>
    </li>
  );
}
