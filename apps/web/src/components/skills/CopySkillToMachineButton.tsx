import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ProviderSkillError,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { CopyIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentProviderEntries } from "../../hooks/useEnvironmentProviderEntries";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { failureMessage } from "../extensions/commandFailure";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

import { msg, t, tn } from "~/i18n";
const isProviderSkillError = Schema.is(ProviderSkillError);
const COPY_FALLBACK = msg("The skill could not be copied.");

export interface CopySkillToMachineButtonProps {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceInstanceId: ProviderInstanceId;
  /** The skill's `path` from the provider's skills list: its SKILL.md. */
  readonly skillPath: string;
  /** Shown in messages; the folder name is what installs. */
  readonly skillName: string;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetInstanceId: ProviderInstanceId;
  /** The machine's name as the user knows it, for the button and messages. */
  readonly targetMachineLabel: string;
  /** The source machine's name as the user knows it, for the linked-skill message. */
  readonly sourceMachineLabel?: string;
}

/** Copies one skill's folder from the source machine to the target's personal skills folder. */
export function CopySkillToMachineButton(props: CopySkillToMachineButtonProps) {
  const label = t("Copy to {machine}", { machine: props.targetMachineLabel });
  const { environments } = useEnvironments();
  const providerEntries = useEnvironmentProviderEntries();
  const advertises = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.environment.capabilities.providerSkillCopy === true;
  const targetCanReceive =
    providerEntries
      .find((entry) => entry.environmentId === props.targetEnvironmentId)
      ?.entries.find((entry) => entry.instanceId === props.targetInstanceId)?.snapshot
      .supportsSkillInstall === true;
  const canInstall = useAtomValue(
    serverEnvironment.installProviderSkill.permissionAtom(props.targetEnvironmentId),
  );
  const [pending, setPending] = useState(false);
  const exportSkill = useAtomCommand(serverEnvironment.exportProviderSkill, {
    reportFailure: false,
  });
  const installSkill = useAtomCommand(serverEnvironment.installProviderSkill, {
    reportFailure: false,
  });

  const copy = (overwrite: boolean) => {
    setPending(true);
    void runCopy(overwrite).finally(() => setPending(false));
  };

  const runCopy = async (overwrite: boolean) => {
    const exported = await exportSkill({
      environmentId: props.sourceEnvironmentId,
      input: { instanceId: props.sourceInstanceId, skillPath: props.skillPath },
    });
    if (exported._tag !== "Success") {
      const description = failureMessage(exported, t(COPY_FALLBACK));
      const exportError = squashAtomCommandFailure(exported);
      if (isProviderSkillError(exportError) && exportError.reason === "linkedSkill") {
        const source = props.sourceMachineLabel ?? t("the source machine");
        toastManager.add({
          type: "error",
          title: t("{skill} is managed by a repository", { skill: props.skillName }),
          description: t(
            "On {source} it lives in {location}. Pull that repository on {target} to get it; for agent-config, its check --fix also links missing skills.",
            {
              source,
              location: exportError.linkTarget ?? t("a linked folder"),
              target: props.targetMachineLabel,
            },
          ),
        });
      } else if (description !== null) {
        toastManager.add({
          type: "error",
          title: t("Could not read {skill}", { skill: props.skillName }),
          description,
        });
      }
      return;
    }
    const skippedLinks = exported.value.skippedLinks ?? 0;
    const installed = await installSkill({
      environmentId: props.targetEnvironmentId,
      input: {
        instanceId: props.targetInstanceId,
        name: exported.value.name,
        files: exported.value.files,
        overwrite,
      },
    });
    if (installed._tag === "Success") {
      toastManager.add({
        type: "success",
        title: t("Copied {skill} to {machine}", {
          skill: props.skillName,
          machine: props.targetMachineLabel,
        }),
        ...(skippedLinks > 0
          ? {
              description: tn(
                skippedLinks,
                "{count} link pointing outside the skill was left out.",
                "{count} links pointing outside the skill were left out.",
              ),
            }
          : {}),
      });
      return;
    }
    const description = failureMessage(installed, t(COPY_FALLBACK));
    if (description === null) return;
    const error = squashAtomCommandFailure(installed);
    if (isProviderSkillError(error) && error.reason === "linkedSkill") {
      toastManager.add({
        type: "error",
        title: t("Nothing was written on {machine}", { machine: props.targetMachineLabel }),
        description: error.linkTarget
          ? t(
              "Its skills there are a link or live in a git repository ({target}). Add {skill} through that repository, such as by pulling agent-config.",
              { target: error.linkTarget, skill: props.skillName },
            )
          : t(
              "Its skills there are a link or live in a git repository. Add {skill} through that repository, such as by pulling agent-config.",
              { skill: props.skillName },
            ),
      });
      return;
    }
    const exists = isProviderSkillError(error) && error.reason === "alreadyExists";
    toastManager.add({
      type: "error",
      title: exists
        ? t("{skill} already exists on {machine}", {
            skill: props.skillName,
            machine: props.targetMachineLabel,
          })
        : t("Could not copy {skill}", { skill: props.skillName }),
      description: exists ? t("Replace it with this version?") : description,
      ...(exists
        ? {
            timeout: 0,
            actionProps: { children: t("Replace"), onClick: () => copy(true) },
          }
        : {}),
    });
  };

  if (!advertises(props.sourceEnvironmentId) || !advertises(props.targetEnvironmentId)) return null;
  if (!targetCanReceive) return null;

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={!canInstall || pending}
      title={
        canInstall
          ? undefined
          : t("You can't change skills on {machine}.", { machine: props.targetMachineLabel })
      }
      onClick={() => copy(false)}
    >
      {pending ? <Spinner size="sm" tone="muted" /> : <CopyIcon />}
      {label}
    </Button>
  );
}
