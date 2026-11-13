#!/usr/bin/env node
// Add a school to a running LOCKqz server. Each school gets its own database and its own Brightspace address.
//   node add-school.mjs --name "State University" --brightspace learn.stateu.edu --domain stateu.edu
//   sudo systemctl reload lockqz-api          (no request is lost; the new school answers from then on)
// --id is made from the name unless given. --brightspace and --domain may be repeated. The Brightspace address
// is checked (it must answer as a Brightspace) unless --no-check. On a server that had one school so far, the
// school it already has is written down first (--first-id usc --first-name ... to name it; USC by default).
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSchools } from "./schools.mjs";

const low = s => String(s || "").trim().toLowerCase();
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
export const hostOnly = v => { let t = low(v); if (!t) return ""; if (!/^https?:\/\//.test(t)) t = "https://" + t; try { const h = new URL(t).hostname; return HOST.test(h) && h.includes(".") ? h : ""; } catch { return ""; } };
export const idFrom = name => low(name).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31).replace(/-+$/, "");

// Is this address a Brightspace? Its version list is public and names the product.
export async function isBrightspace(host, fetcher = fetch) {
  try { const r = await fetcher(`https://${host}/d2l/api/versions/`, { signal: AbortSignal.timeout(15000), redirect: "error" }); if (!r.ok) return false;
    const d = await r.json(); return Array.isArray(d) && d.some(x => x && x.ProductCode === "lp"); } catch { return false; }
}

export async function addSchool({ dataDir, id, name, brightspace = [], domains = [], check = true, fetcher, first = {} }) {
  const file = join(resolve(dataDir), "schools.json");
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))
    : { default: low(first.id || "usc"), schools: [{ id: low(first.id || "usc"), name: first.name || "University of Southern California",
        brightspace: first.brightspace || ["brightspace.usc.edu", "usc.brightspace.com"], domains: first.domains || ["usc.edu"] }] };
  const bs = [...new Set(brightspace.map(hostOnly))], dm = [...new Set(domains.map(d => low(d).replace(/^@/, "")))];
  if (!name || !String(name).trim()) throw new Error("the school needs a name (--name)");
  if (!bs.length || bs.includes("")) throw new Error("the school needs its Brightspace address (--brightspace learn.school.edu)");
  if (dm.some(d => !HOST.test(d) || !d.includes("."))) throw new Error("--domain is the part of the school's email addresses after @ (school.edu)");
  const sid = low(id) || idFrom(name);
  if (check) for (const h of bs) if (!(await isBrightspace(h, fetcher))) throw new Error(h + " does not answer as a Brightspace (use --no-check to add it anyway)");
  const next = { ...cfg, schools: [...cfg.schools, { id: sid, name: String(name).trim(), brightspace: bs, domains: dm }] };
  readSchools(next);   // refuses a repeated id, address or email domain
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + ".new", JSON.stringify(next, null, 2) + "\n", { mode: 0o640 }); renameSync(file + ".new", file);
  return { file, id: sid, schools: next.schools.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), all = k => a.flatMap((x, i) => x === "--" + k && a[i + 1] ? [a[i + 1]] : []), one = k => all(k)[0];
  const HERE = dirname(fileURLToPath(import.meta.url));
  try {
    const r = await addSchool({ dataDir: one("data") || process.env.LOCKQZ_DATA || join(HERE, "data"), id: one("id"), name: one("name"), brightspace: all("brightspace"), domains: all("domain"),
      check: !a.includes("--no-check"), first: { id: one("first-id"), name: one("first-name") } });
    console.log(`added school "${r.id}" (${r.schools} schools) to ${r.file}\nnow run: sudo systemctl reload lockqz-api`);
  } catch (e) { console.error("not added: " + e.message); process.exit(1); }
}
