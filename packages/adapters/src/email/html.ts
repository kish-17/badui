/**
 * Dependency-free HTML helpers for email bodies. Email HTML is table soup
 * written for 2005-era renderers, so a forgiving regex pass that keeps the
 * *row/cell* structure (rows -> lines, cells -> tabs) is more useful to the
 * extractors than a real DOM: "Order Total:\t₹4,799.00" stays on one line.
 *
 * Nothing here executes or fetches anything; scripts, styles, images and links
 * are dropped, never followed.
 */

/**
 * Upper bound on the HTML a single email may contribute. Real receipts are
 * well under 1 MB; anything larger is cut rather than allowed to stall an
 * on-device parse.
 */
export const MAX_HTML_CHARS = 2_000_000;

/** Elements whose content is never visible text. */
const DROP_WITH_CONTENT: ReadonlySet<string> = new Set(["script", "style", "head", "title", "noscript", "template", "svg", "object", "iframe"]);

/**
 * Hidden preheaders ("display:none" teaser text) often repeat marketing copy
 * or a stale total. Only simple, non-nested blocks are removed; a nested one
 * leaves its tail visible, which is harmless.
 */
const HIDDEN_CONTAINERS: ReadonlySet<string> = new Set(["div", "span", "p", "td", "table"]);
const HIDDEN_STYLE = /\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|mso-hide\s*:\s*all)/i;

/** Tags that end a visual line. */
const BLOCK_TAGS: ReadonlySet<string> = new Set(
  "p div tr li ul ol h1 h2 h3 h4 h5 h6 table tbody thead tfoot section article header footer blockquote pre dt dd dl center address form fieldset figure figcaption main nav aside br hr".split(" "),
);

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
  const s = decodeEntities(stripMarkup(typeof html === "string" ? html.slice(0, MAX_HTML_CHARS) : "")).replace(INVISIBLE, "");
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

/**
 * One left-to-right pass over the markup: tags become "\n" (block), "\t"
 * (cell) or nothing (inline); comments, CDATA, script/style/head and hidden
 * preheaders are dropped with their content. Every search moves forward with
 * `indexOf`, and a closing tag that is missing once is remembered as missing,
 * so time is linear in the input even for hostile, unclosed markup (a regex
 * `[\s\S]*?</script>` per opening tag is quadratic on `<script>` x 20,000).
 * Unclosed comments and dropped elements hide the rest of the document, as in
 * a browser.
 */
function stripMarkup(src: string): string {
  const lower = src.toLowerCase();
  const out: string[] = [];
  const unclosed = new Set<string>();
  /** Index just past `</name …>` at or after `from`, or -1 (and remembered) when there is none. */
  const closeOf = (name: string, from: number): number => {
    if (unclosed.has(name)) return -1;
    const at = lower.indexOf(`</${name}`, from);
    const gt = at < 0 ? -1 : src.indexOf(">", at);
    if (gt < 0) {
      unclosed.add(name);
      return -1;
    }
    return gt + 1;
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      out.push(src.slice(i));
      break;
    }
    out.push(src.slice(i, lt));
    if (src.startsWith("<!--", lt) || src.startsWith("<![CDATA[", lt)) {
      const comment = src.startsWith("<!--", lt);
      const end = src.indexOf(comment ? "-->" : "]]>", lt + 4);
      if (end < 0) break;
      out.push(" ");
      i = end + 3;
      continue;
    }
    const gt = src.indexOf(">", lt + 1);
    if (gt < 0) {
      // A stray "<" with no tag after it is text ("price < ₹500").
      out.push(src.slice(lt));
      break;
    }
    const tag = src.slice(lt + 1, gt);
    const m = /^(\/?)\s*([a-zA-Z][\w:-]*)/.exec(tag);
    i = gt + 1;
    if (!m) continue;
    const closing = m[1] === "/";
    const name = (m[2] ?? "").toLowerCase();
    const selfClosing = tag.endsWith("/");
    if (!closing && !selfClosing && DROP_WITH_CONTENT.has(name)) {
      const end = closeOf(name, i);
      if (end < 0) break;
      out.push(" ");
      i = end;
      continue;
    }
    if (!closing && !selfClosing && HIDDEN_CONTAINERS.has(name) && HIDDEN_STYLE.test(tag)) {
      const end = closeOf(name, i);
      if (end >= 0) {
        out.push(" ");
        i = end;
        continue;
      }
    }
    if (BLOCK_TAGS.has(name)) out.push("\n");
    else if (name === "td" || name === "th") out.push("\t");
  }
  return out.join("");
}

/**
 * schema.org JSON-LD nodes embedded in an HTML email
 * (`<script type="application/ld+json">`). Arrays and `@graph` containers are
 * flattened into a list of nodes; blocks that are not valid JSON are skipped,
 * since senders' markup is attacker-controllable and often sloppy.
 */
export function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  if (typeof html !== "string") return out;
  const src = html.slice(0, MAX_HTML_CHARS);
  const lower = src.toLowerCase();
  // Linear scan (see stripMarkup): each search starts where the previous one ended.
  for (let i = lower.indexOf("<script"); i >= 0 && out.length < MAX_LD_NODES; i = lower.indexOf("<script", i)) {
    const gt = src.indexOf(">", i);
    if (gt < 0) break;
    const open = lower.slice(i, gt);
    const close = lower.indexOf("</script", gt + 1);
    if (close < 0) break;
    i = close + 8;
    if (!/\btype\s*=\s*["']?application\/ld\+json/.test(open)) continue;
    const raw = src
      .slice(gt + 1, close)
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

/** Nodes and nesting kept from one email; markup is sender-controlled, so both are bounded. */
const MAX_LD_NODES = 200;
const MAX_LD_DEPTH = 8;

function flattenJsonLd(value: unknown, out: unknown[], depth = 0): void {
  if (out.length >= MAX_LD_NODES || depth > MAX_LD_DEPTH) return;
  if (Array.isArray(value)) {
    for (const v of value) flattenJsonLd(v, out, depth + 1);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const graph = (value as Record<string, unknown>)["@graph"];
  if (Array.isArray(graph)) {
    for (const v of graph) flattenJsonLd(v, out, depth + 1);
    return;
  }
  out.push(value);
}
