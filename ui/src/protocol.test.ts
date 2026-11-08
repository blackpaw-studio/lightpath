import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClientMsg, parseServerMsg } from "./protocol";

const dir = join(__dirname, "../../internal/protocol/testdata");
const load = (prefix: string) =>
  readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}.`) && f.endsWith(".json"))
    .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

describe("golden protocol files", () => {
  it.each(load("server"))("parses server %s", (_name, text) => {
    const msg = parseServerMsg(text);
    expect(msg).toEqual(JSON.parse(text));
  });

  it.each(load("client"))("parses client %s", (_name, text) => {
    expect(parseClientMsg(text)).toEqual(JSON.parse(text));
  });

  it("has golden files for every message type", () => {
    const types = new Set(
      [...load("server"), ...load("client")].map(([, t]) => JSON.parse(t).type),
    );
    for (const t of ["trace.start", "trace.cancel", "trace.started", "hop", "hop.update", "trace.done", "error"]) {
      expect(types).toContain(t);
    }
  });

  it("keeps absent and null distinct in hop.update", () => {
    const partial = parseServerMsg('{"type":"hop.update","ttl":3,"asn":1}');
    expect("host" in partial).toBe(false);
    const nulled = parseServerMsg('{"type":"hop.update","ttl":3,"host":null}');
    expect(nulled).toMatchObject({ host: null });
  });

  it.each(["", "{}", "[]", '{"type":"nope"}', '{"type":"hop.update"}', '{"type":"hop.update","ttl":"3"}', '{"type":"hop","ttl":1}', '{"type":"trace.done","reached":"yes"}'])(
    "rejects malformed server input %j",
    (text) => {
      expect(() => parseServerMsg(text)).toThrow();
    },
  );
});
