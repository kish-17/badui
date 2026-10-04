/**
 * Dependency-free HTML helpers for email bodies. Email HTML is table soup
 * written for 2005-era renderers, so a forgiving regex pass that keeps the
 * *row/cell* structure (rows -> lines, cells -> tabs) is more useful to the
 * extractors than a real DOM: "Order Total:\t₹4,799.00" stays on one line.
 *
 * Nothing here executes or fetches anything; scripts, styles, images and links
 * are dropped, never followed.
 */

/** Elements whose content is never visible text. */
const DROP_WITH_CONTENT = /<(script|style|head|title|noscript|template|svg|object|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * Hidden preheaders ("display:none" teaser text) often repeat marketing copy
 * or a stale total. Only simple, non-nested blocks are removed; a nested one
 * leaves its tail visible, which is harmless.
 */
const HIDDEN_BLOCK =
  /<(div|span|p|td|table)\b[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|mso-hide\s*:\s*all)[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Tags that end a visual line. */
const BLOCK_TAGS =
  "p|div|tr|li|ul|ol|h[1-6]|table|tbody|thead|tfoot|section|article|header|footer|blockquote|pre|dt|dd|dl|center|address|form|fieldset|figure|figcaption|main|nav|aside";

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  sbquo: "‚",
  bdquo: "„",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  times: "×",
  divide: "÷",
  deg: "°",
  rarr: "→",
  larr: "←",
  laquo: "«",
  raquo: "»",
  zwnj: "",
  zwj: "",
  shy: "",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  iexcl: "¡",
  iquest: "¿",
  ordm: "º",
  ordf: "ª",
  sect: "§",
  para: "¶",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  atilde: "ã",
  otilde: "õ",
  ccedil: "ç",
  agrave: "à",
  egrave: "è",
  acirc: "â",
  ecirc: "ê",
  ocirc: "ô",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  ntilde: "ñ",
  Aacute: "Á",
  Eacute: "É",
  Ccedil: "Ç",
};

/** Decode named, decimal and hex character references. Unknown names are left as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return code === 0xa0 ? " " : String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/** Zero-width and soft-hyphen characters that marketing templates sprinkle between letters. */
const INVISIBLE = /[​‌‍⁠﻿­͏]/g;

/**
 * Visible text of an HTML email: hidden blocks, scripts, styles and the head
 * are dropped; block elements and `<br>` become newlines, table cells become
 * tabs; entities are decoded; whitespace is collapsed and blank lines removed.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ")
    .replace(DROP_WITH_CONTENT, " ")
    .replace(HIDDEN_BLOCK, " ");
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\b[^>]*>/gi, "\n")
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<\/?t[dh]\b[^>]*>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s).replace(INVISIBLE, "");
  return s
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/[        \f\v]+/g, " ")
        .split("\t")
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0)
        .join("\t"),
    )
    .filter((line) => line.length > 0)
    .join("\n");
}

const LD_JSON_SCRIPT = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;

/**
 * schema.org JSON-LD nodes embedded in an HTML email
 * (`<script type="application/ld+json">`). Arrays and `@graph` containers are
 * flattened into a list of nodes; blocks that are not valid JSON are skipped,
 * since senders' markup is attacker-controllable and often sloppy.
 */
export function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  LD_JSON_SCRIPT.lastIndex = 0;
  for (let m = LD_JSON_SCRIPT.exec(html); m !== null; m = LD_JSON_SCRIPT.exec(html)) {
    const raw = (m[1] ?? "")
      .replace(/^\s*<!--/, "")
      .replace(/-->\s*$/, "")
      .replace(/^\s*<!\[CDATA\[/, "")
      .replace(/\]\]>\s*$/, "")
      .trim();
    if (raw.length === 0) continue;
    const parsed = parseJsonLenient(raw);
    if (parsed !== undefined) flattenJsonLd(parsed, out);
  }
  return out;
}

/** JSON.parse, retried once on entity-encoded markup (some ESPs HTML-escape script contents). */
function parseJsonLenient(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    try {
      return JSON.parse(decodeEntities(raw)) as unknown;
    } catch {
      return undefined;
    }
  }
}

function flattenJsonLd(value: unknown, out: unknown[]): void {
  if (Array.isArray(value)) {
    for (const v of value) flattenJsonLd(v, out);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const graph = (value as Record<string, unknown>)["@graph"];
  if (Array.isArray(graph)) {
    for (const v of graph) flattenJsonLd(v, out);
    return;
  }
  out.push(value);
}
