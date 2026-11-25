import { GuestMessageId } from "@t3tools/contracts";

export const guestMessage = {
  role: "user",
  createdBy: "user",
  text: "Message from guest Sam, sent by the owner:\n\nWhy?",
  context: {
    version: 1,
    records: [],
    guest: {
      guestMessageId: GuestMessageId.make("guest-message:one"),
      name: "Sam",
      text: "Why?",
    },
  },
} as const;

export function legacyScheduledMessage(trigger: string) {
  return {
    id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
    role: "user",
    createdBy: "user",
    text: "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n",
  } as const;
}
