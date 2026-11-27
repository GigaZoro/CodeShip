import type { UiCaptureContext } from "./captureContext";

/** One press of the capture key. Kept in this browser profile only. */
export interface UiCapture extends UiCaptureContext {
  readonly id: string;
  readonly createdAt: string;
  readonly note: string;
  /** The person ticked "attach a screenshot"; the image itself is read with `getUiCaptureScreenshot`. */
  readonly hasScreenshot: boolean;
}

const MAX_UI_CAPTURES = 300;
export const MAX_UI_CAPTURE_NOTE_LENGTH = 120;

const DATABASE_NAME = "t3code:ui-feedback";
const DATABASE_VERSION = 1;
const STORE_NAME = "captures";
// Images live apart so listing captures, the reminder and the hourly export never load them.
const SCREENSHOT_STORE_NAME = "screenshots";

let database: Promise<IDBDatabase> | undefined;
let snapshot: ReadonlyArray<UiCapture> | null = null;
const listeners = new Set<() => void>();

function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this browser context."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains(SCREENSHOT_STORE_NAME)) {
        request.result.createObjectStore(SCREENSHOT_STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => reject(new Error("UI feedback storage is blocked.")));
  }).catch((cause: unknown) => {
    database = undefined;
    throw cause;
  }));
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

function byNewestFirst(left: UiCapture, right: UiCapture): number {
  return right.createdAt.localeCompare(left.createdAt);
}

/** The captures to delete so that `incoming` plus the rest fit in `max`, oldest first. */
export function capturesToPrune(
  existing: ReadonlyArray<Pick<UiCapture, "id" | "createdAt">>,
  max = MAX_UI_CAPTURES,
): string[] {
  const overflow = existing.length + 1 - max;
  if (overflow <= 0) return [];
  return existing
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, overflow)
    .map((capture) => capture.id);
}

function publish(next: ReadonlyArray<UiCapture>): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

async function readAll(): Promise<UiCapture[]> {
  const transaction = (await openDatabase()).transaction(STORE_NAME, "readonly");
  const request = transaction.objectStore(STORE_NAME).getAll() as IDBRequest<UiCapture[]>;
  await completed(transaction);
  return request.result.toSorted(byNewestFirst);
}

/** Always reads storage: another tab or window may have added or deleted captures. */
export async function loadUiCaptures(): Promise<ReadonlyArray<UiCapture>> {
  const captures = await readAll();
  publish(captures);
  return captures;
}

async function writeTransaction(): Promise<{
  readonly transaction: IDBTransaction;
  readonly captures: IDBObjectStore;
  readonly screenshots: IDBObjectStore;
}> {
  const transaction = (await openDatabase()).transaction(
    [STORE_NAME, SCREENSHOT_STORE_NAME],
    "readwrite",
  );
  return {
    transaction,
    captures: transaction.objectStore(STORE_NAME),
    screenshots: transaction.objectStore(SCREENSHOT_STORE_NAME),
  };
}

export async function addUiCapture(capture: UiCapture, screenshot: string | null): Promise<void> {
  const existing = await loadUiCaptures();
  const pruned = new Set(capturesToPrune(existing));
  const { transaction, captures, screenshots } = await writeTransaction();
  for (const id of pruned) {
    captures.delete(id);
    screenshots.delete(id);
  }
  captures.put(capture);
  if (screenshot !== null) screenshots.put(screenshot, capture.id);
  await completed(transaction);
  publish([capture, ...existing.filter((entry) => !pruned.has(entry.id))].toSorted(byNewestFirst));
}

/** The JPEG data URL attached to a capture, or null when it has none. */
export async function getUiCaptureScreenshot(id: string): Promise<string | null> {
  const transaction = (await openDatabase()).transaction(SCREENSHOT_STORE_NAME, "readonly");
  const request = transaction.objectStore(SCREENSHOT_STORE_NAME).get(id) as IDBRequest<
    string | undefined
  >;
  await completed(transaction);
  return request.result ?? null;
}

export async function deleteUiCapture(id: string): Promise<void> {
  const { transaction, captures, screenshots } = await writeTransaction();
  captures.delete(id);
  screenshots.delete(id);
  await completed(transaction);
  publish((snapshot ?? []).filter((capture) => capture.id !== id));
}

export async function clearUiCaptures(): Promise<void> {
  const { transaction, captures, screenshots } = await writeTransaction();
  captures.clear();
  screenshots.clear();
  await completed(transaction);
  publish([]);
}

/** Null until the first load finishes. */
export function readUiCapturesSnapshot(): ReadonlyArray<UiCapture> | null {
  return snapshot;
}

export function subscribeUiCaptures(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
