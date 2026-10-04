import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Architecture fitness tests. They make the brief's central rule executable:
 * "The product intelligence layer should not care which provider produced
 * [observations]." Provider knowledge belongs in adapters only.
 */

const ROOT = join(__dirname, "..", "..", "..");

function sourceFiles(pkg: string): string[] {
  const dir = join(ROOT, "packages", pkg, "src");
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function imports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
}

const ALLOWED_DEPENDENCIES: Record<string, readonly string[]> = {
  core: [],
  intelligence: ["@brake/core"],
  capabilities: ["@brake/core"],
  adapters: ["@brake/core"],
  // Infrastructure: the only package allowed to know about a database vendor.
  supabase: ["@brake/core", "@supabase/supabase-js"],
};

describe("package dependency rules", () => {
  for (const [pkg, allowed] of Object.entries(ALLOWED_DEPENDENCIES)) {
    it(`${pkg} only depends on ${allowed.length ? allowed.join(", ") : "nothing"}`, () => {
      const violations: string[] = [];
      for (const file of sourceFiles(pkg)) {
        for (const spec of imports(file)) {
          if (spec.startsWith(".") || spec.startsWith("node:")) {
            if (spec.startsWith("node:")) violations.push(`${relative(ROOT, file)} imports ${spec} (no platform APIs in shared packages)`);
            continue;
          }
          const base = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
          if (!allowed.includes(base)) violations.push(`${relative(ROOT, file)} imports ${spec}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});

/**
 * Provider, aggregator, OS-API and channel names that must never drive
 * intelligence logic. (Merchant names in merchant-profiles.ts are merchant
 * context, not data providers, and are allowed.)
 */
const PROVIDER_TOKENS = [
  /\bplaid\b/i,
  /\bgmail\b/i,
  /\boutlook\b/i,
  /\baccount[\s_-]?aggregator\b/i,
  /\bsahamati\b/i,
  /\bfinancekit\b/i,
  /\bnotificationlistener/i,
  /\btruelayer\b|\btink\b|\byodlee\b|\bfinicity\b|\bbelvo\b/i,
  /\bhdfc\b|\bicici\b|\bchase\b(?!\w)/i,
];

describe("intelligence is provider-blind", () => {
  for (const file of sourceFiles("intelligence")) {
    const rel = relative(ROOT, file);
    if (rel.endsWith("merchant-profiles.ts")) continue;
    it(`${rel} has no provider-specific logic`, () => {
      const code = readFileSync(file, "utf8")
        // Comments may mention providers to explain *why* something is neutral.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      const hits = PROVIDER_TOKENS.filter((re) => re.test(code)).map(String);
      expect(hits).toEqual([]);
      expect(code).not.toMatch(/\.adapterId\b/);
      expect(code).not.toMatch(/\.connectionId\b/);
    });
  }
});
