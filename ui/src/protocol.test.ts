import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, parseClientMsg, parseServerMsg } from "./protocol";

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

const destReach = '{"ip":"198.51.100.77","reachable":true,"port":443,"rttMs":18.4,"host":null,"asn":null,"org":null,"lat":null,"lon":null,"city":null,"geoSource":"api"}';
const destUnreach = '{"ip":"203.0.113.9","reachable":false,"port":null,"rttMs":null,"host":null,"asn":null,"org":null,"lat":null,"lon":null,"city":null,"geoSource":"estimated"}';
const done = (extra: string) => `{"type":"trace.done",${extra}}`;

describe("trace.done v2 (reason, destination)", () => {
  it.each([
    done('"reached":true'),
    done('"reached":true,"reason":"reached"'),
    done('"reached":false,"reason":"error"'),
    done(`"reached":false,"reason":"quiet","destination":${destReach}`),
  ])("accepts %j", (text) => {
    expect(() => parseServerMsg(text)).not.toThrow();
  });

  it.each<[string, string]>([
    ["null reason", done('"reached":false,"reason":null')],
    ["bogus reason", done('"reached":false,"reason":"bogus"')],
    ["empty reason", done('"reached":false,"reason":""')],
    ["null destination", done('"reached":false,"destination":null')],
    ["destination missing reachable", done(`"reached":false,"reason":"quiet","destination":${destUnreach.replace('"reachable":false,', "")}`)],
    ["reachable with null port", done(`"reached":false,"reason":"quiet","destination":${destReach.replace('"port":443', '"port":null')}`)],
    ["reachable with null rtt", done(`"reached":false,"reason":"quiet","destination":${destReach.replace('"rttMs":18.4', '"rttMs":null')}`)],
    ["unreachable with port", done(`"reached":false,"reason":"quiet","destination":${destUnreach.replace('"port":null', '"port":443')}`)],
    ["unreachable with rtt", done(`"reached":false,"reason":"quiet","destination":${destUnreach.replace('"rttMs":null', '"rttMs":1.5')}`)],
    ["destination bad geoSource", done(`"reached":false,"reason":"quiet","destination":${destUnreach.replace('"estimated"', '"gps"')}`)],
    ["destination null ip", done(`"reached":false,"reason":"quiet","destination":${destUnreach.replace('"203.0.113.9"', "null")}`)],
    ["reached true with quiet", done('"reached":true,"reason":"quiet"')],
    ["reached false with reached", done('"reached":false,"reason":"reached"')],
  ])("rejects %s", (_name, text) => {
    expect(() => parseServerMsg(text)).toThrow();
  });
});

describe("protocol version", () => {
  it("matches the Go constant", () => {
    const go = readFileSync(join(dir, "../protocol.go"), "utf8");
    const m = /^const Version = (\d+)$/m.exec(go);
    expect(m).not.toBeNull();
    expect(PROTOCOL_VERSION).toBe(Number(m![1]));
  });
});

