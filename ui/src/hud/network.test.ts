import { describe, expect, it } from "vitest";
import { shortNetworkName } from "./network";

describe("shortNetworkName: curated table", () => {
  it.each([
    ["UUNET - Verizon Business, US", 701, "Verizon"],
    ["MCI Communications Services, Inc. d/b/a Verizon Business", null, "Verizon"],
    ["COMCAST-7922", 7922, "Comcast"],
    ["AT&T Services, Inc.", null, "AT&T"],
    ["LEVEL3", 3356, "Lumen"],
    ["Lumen Technologies", null, "Lumen"],
    ["CenturyLink Communications, LLC", null, "Lumen"],
    ["COGENT-174", 174, "Cogent"],
    ["Charter Communications Inc", null, "Spectrum"],
    ["Spectrum", null, "Spectrum"],
    ["Cox Communications Inc.", null, "Cox"],
    ["GOOGLE", 15169, "Google"],
    ["Cloudflare, Inc.", 13335, "Cloudflare"],
    ["AMAZON-02", 16509, "Amazon"],
    ["Amazon.com, Inc.", null, "Amazon"],
    ["MICROSOFT-CORP-MSN-AS-BLOCK", 8075, "Microsoft"],
    ["Akamai International B.V.", 20940, "Akamai"],
    ["Fastly, Inc.", null, "Fastly"],
    ["Hurricane Electric LLC", 6939, "Hurricane Electric"],
    ["NTT America, Inc.", null, "NTT"],
    ["NTT-LTD-2914", 2914, "NTT"],
    ["Telia Company AB", null, "Arelion"],
    ["Arelion Sweden AB", 1299, "Arelion"],
    ["Zayo Bandwidth", null, "Zayo"],
    ["GTT Communications Inc.", null, "GTT"],
    ["Tata Communications (America) Inc.", null, "Tata"],
    ["Facebook, Inc.", 32934, "Meta"],
    ["Meta Platforms, Inc.", null, "Meta"],
    ["Apple Inc.", null, "Apple"],
    ["PCCWG-APAC-HK - PCCW Global, Inc., HK", null, "PCCW Global"],
    ["PCCW Global, Inc.", 3491, "PCCW Global"],
    ["YANDEX - YANDEX LLC, RU", 13238, "Yandex"],
    ["YANDEX - YANDEX LLC, RU", null, "Yandex"],
  ])("%s (AS%s) → %s", (org, asn, expected) => {
    expect(shortNetworkName(org, asn)).toBe(expected);
  });

  it("matches on ASN alone when the org is missing", () => {
    expect(shortNetworkName(null, 701)).toBe("Verizon");
    expect(shortNetworkName(null, 13335)).toBe("Cloudflare");
  });

  it("prefers the ASN over a misleading org string", () => {
    expect(shortNetworkName("Some Reseller of Google Fiber", 7922)).toBe("Comcast");
  });

  it("does not match carrier names inside unrelated words", () => {
    expect(shortNetworkName("Coxswain Hosting", null)).toBe("Coxswain Hosting");
    expect(shortNetworkName("Pineapple Networks", null)).toBe("Pineapple");
  });
});

describe("shortNetworkName: cleanup heuristic", () => {
  it.each([
    ["AS15133 EDGECAST", "Edgecast"],
    ["AS64500 Example Telecom Inc.", "Example Telecom"],
    ["EXAMPLE-NET - Example Networks, LLC", "Example"],
    ["QRSTUV-AS-AP - Quartz Fibre Ltd, AU", "Quartz Fibre"],
    ["HANDLE-ONLY - , US", "Handle-Only"],
    ["Foo Bar Communications, US", "Foo Bar"],
    ["Acme Networks Ltd", "Acme"],
    ["DigitalOcean, LLC", "DigitalOcean"],
    ["OVH SAS", "OVH SAS"],
    ["  spaced   out  corp ", "Spaced Out"],
  ])("%s → %s", (org, expected) => {
    expect(shortNetworkName(org, 64500)).toBe(expected);
  });

  it.each([[null], [""], ["   "], ["AS64500"], ["Inc."], [", US"], ["- -"]])("returns null for junk %j", (org) => {
    expect(shortNetworkName(org, 64500)).toBeNull();
  });

  it("returns null with neither org nor a known ASN", () => {
    expect(shortNetworkName(null, null)).toBeNull();
    expect(shortNetworkName(null, 64500)).toBeNull();
  });
});
