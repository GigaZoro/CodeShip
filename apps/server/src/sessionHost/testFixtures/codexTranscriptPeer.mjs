// A fake Codex app server: it plays a recorded transcript over stdio, checks each message it
// receives against it, and logs every received message so a test can prove what a server sent.
// Usage: node codexTranscriptPeer.mjs <transcript.ndjson> <log.ndjson> [pauseBeforeMethod]
// pauseBeforeMethod holds output from that method until the control port receives "continue".
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeReadline from "node:readline";

const [transcriptPath, logPath, pauseBeforeMethod] = process.argv.slice(2);
const entries = NodeFS.readFileSync(transcriptPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.type === "expect_outbound" || entry.type === "emit_inbound");

const log = (record) => NodeFS.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
const write = (frame, done) => process.stdout.write(`${JSON.stringify(frame)}\n`, done);

let cursor = 0;
let initialized = false;
let paused = pauseBeforeMethod !== undefined;
// Recorded request id -> the id the client used for it.
const requestIds = new Map();

const isResponse = (frame) => frame.method === undefined && frame.id !== undefined;

/** Writes the frames recorded before the next expected message; done runs once they are out. */
const pump = (done = () => {}) => {
  let pending = 1;
  const settle = () => {
    pending -= 1;
    if (pending === 0) done();
  };
  while (cursor < entries.length && entries[cursor].type === "emit_inbound") {
    const frame = entries[cursor].frame;
    if (paused && frame.method === pauseBeforeMethod) break;
    cursor += 1;
    pending += 1;
    write(
      isResponse(frame) && requestIds.has(frame.id)
        ? { ...frame, id: requestIds.get(frame.id) }
        : frame,
      settle,
    );
  }
  settle();
};

const control = NodeNet.createServer((socket) => {
  NodeReadline.createInterface({ input: socket }).on("line", (line) => {
    if (line !== "continue") return;
    paused = false;
    pump(() => socket.end("done\n"));
  });
});
control.listen(0, "127.0.0.1", () => {
  log({ kind: "started", pid: process.pid, controlPort: control.address().port });
});

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim().length === 0) return;
  const message = JSON.parse(line);
  log({ kind: "received", method: message.method ?? null, id: message.id ?? null });
  if (message.method === "initialize" && initialized) {
    write({ id: message.id, error: { code: -32600, message: "Already initialized" } });
    return;
  }
  const expected = entries[cursor];
  const matches =
    expected !== undefined &&
    expected.type === "expect_outbound" &&
    (message.method === undefined
      ? expected.frame.method === undefined && expected.frame.id === message.id
      : expected.frame.method === message.method);
  if (!matches) {
    log({ kind: "unexpected", method: message.method ?? null, id: message.id ?? null });
    if (message.method !== undefined && message.id !== undefined) {
      write({ id: message.id, error: { code: -32601, message: `Unexpected ${message.method}` } });
    }
    return;
  }
  if (message.method === "initialize") initialized = true;
  if (message.method !== undefined && message.id !== undefined) {
    requestIds.set(expected.frame.id, message.id);
  }
  cursor += 1;
  pump();
});
process.stdin.on("end", () => process.exit(0));
