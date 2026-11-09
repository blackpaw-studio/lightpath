// Short, human network names for the hop list. Pure; no DOM.

interface Known {
  readonly name: string;
  readonly asns: readonly number[];
  readonly org: RegExp;
}

// Curated carriers and clouds. Matched on ASN first (authoritative), then org text.
const KNOWN: readonly Known[] = [
  { name: "Verizon", asns: [701, 702, 703, 6167, 22394], org: /\b(verizon|uunet|cellco)\b/i },
  { name: "Comcast", asns: [7922, 33651, 33650, 7725], org: /\bcomcast\b/i },
  { name: "AT&T", asns: [7018, 7132, 20057], org: /\bat&t\b|\bat&amp;t\b/i },
  { name: "Lumen", asns: [3356, 3549, 209, 3561], org: /\b(lumen|level\s?3|centurylink|qwest)\b/i },
  { name: "Cogent", asns: [174], org: /\bcogent\b/i },
  { name: "Spectrum", asns: [20115, 33363, 11426, 12271], org: /\b(charter|spectrum)\b/i },
  { name: "Cox", asns: [22773], org: /\bcox\b/i },
  { name: "Google", asns: [15169, 396982], org: /\bgoogle\b/i },
  { name: "Cloudflare", asns: [13335], org: /\bcloudflare\b/i },
  { name: "Amazon", asns: [16509, 14618], org: /\b(amazon|aws)\b/i },
  { name: "Microsoft", asns: [8075], org: /\bmicrosoft\b/i },
  { name: "Akamai", asns: [20940, 16625], org: /\bakamai\b/i },
  { name: "Fastly", asns: [54113], org: /\bfastly\b/i },
  { name: "Hurricane Electric", asns: [6939], org: /\bhurricane electric\b/i },
  { name: "NTT", asns: [2914], org: /\bntt\b/i },
  { name: "Arelion", asns: [1299], org: /\b(telia|arelion)\b/i },
  { name: "Zayo", asns: [6461], org: /\bzayo\b/i },
  { name: "GTT", asns: [3257], org: /\bgtt\b/i },
  { name: "Tata", asns: [6453], org: /\btata\b/i },
  { name: "Meta", asns: [32934], org: /\b(meta platforms|facebook)\b/i },
  { name: "Apple", asns: [714, 6185], org: /^apple\b/i },
];

const CORPORATE_SUFFIXES: ReadonlySet<string> = new Set([
  "inc", "llc", "ltd", "limited", "corp", "corporation", "co", "plc", "gmbh",
  "communications", "communication", "networks", "network",
]);

const bare = (word: string): string => word.toLowerCase().replace(/[.,]+$/g, "");

const titleCase = (word: string): string => {
  const isAllCaps = word === word.toUpperCase() && word !== word.toLowerCase();
  if (isAllCaps && word.length <= 3) return word; // OVH, GTT-style acronyms
  if (word !== word.toUpperCase() && word !== word.toLowerCase()) return word; // DigitalOcean
  return word.toLowerCase().replace(/(^|-)([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase());
};

const clean = (org: string): string | null => {
  const head = org.split(/\s-\s|,|\(/)[0] ?? "";
  const words = head.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  while (words.length > 0 && /^AS\d+$/i.test(words[0]!)) words.shift();
  while (words.length > 0 && CORPORATE_SUFFIXES.has(bare(words.at(-1)!))) words.pop();
  return words.length === 0 ? null : words.map(titleCase).join(" ");
};

/** "UUNET - Verizon Business, US" → "Verizon"; unknown orgs are cleaned up; null when nothing usable. */
export const shortNetworkName = (org: string | null, asn: number | null): string | null => {
  const byAsn = asn === null ? undefined : KNOWN.find((k) => k.asns.includes(asn));
  if (byAsn) return byAsn.name;
  const text = org?.trim() ?? "";
  if (text === "") return null;
  return KNOWN.find((k) => k.org.test(text))?.name ?? clean(text);
};
