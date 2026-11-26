import { expect, it, vi } from "vite-plus/test";
import { bindReviewMaterial } from "./reviewMaterial.ts";

it("serves and records only the evaluator's exact material requests", async () => {
  const packet = { handle: "synthetic-packet" };
  const source = { handle: "synthetic-source", side: "base", path: "src/example.ts" };
  const text = "\uFEFFsynthetic π";
  const read = vi.fn(async () => new TextEncoder().encode(text));
  const record = vi.fn(async () => {});
  for (const path of ["/private/source", "C:\\private", "../other", "dir/./file"]) {
    expect(() =>
      bindReviewMaterial({ allowedReads: [{ ...source, path }], read, record }),
    ).toThrow();
  }
  const { read_material } = bindReviewMaterial({ allowedReads: [packet, source], read, record });
  for (const request of [
    { handle: "synthetic-other" },
    { ...packet, slot: "other" },
    { ...source, side: "head" },
    { ...source, path: "../other" },
    { handle: source.handle },
  ]) {
    await expect(read_material(request)).rejects.toThrow("Material read unavailable.");
  }
  expect(read).not.toHaveBeenCalled();
  for (const request of [packet, source]) {
    await expect(read_material(request)).resolves.toBe(text);
    expect(record).toHaveBeenLastCalledWith(request, {
      byteLength: 15,
      sha256: "ddf70753576a67bc15a31cac8905b8667cd09f23cde0885cf4986aa4d1c01e9b",
    });
  }
  record.mockRejectedValueOnce(new Error("private evaluator detail"));
  await expect(read_material(packet)).rejects.toThrow(/^Material read unavailable\.$/);
});
