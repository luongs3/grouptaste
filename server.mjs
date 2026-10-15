// GroupTaste — pick the venue a whole group will like, not the one the loudest member likes.
// Each member gives a few things they love. For every candidate venue, Qloo ranks it against
// EACH member's taste separately (`qloo exec rank`). The agent picks the venue with the best
// worst-member score (maximin), and shows per-member evidence.
import http from "node:http";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.PORT || 8809);
const FIXTURES = process.env.GROUPTASTE_FIXTURES; // JSON file of recorded qloo responses (demo without key)
const fixtures = FIXTURES ? JSON.parse(readFileSync(FIXTURES, "utf8")) : null;

// Live mode keeps a disk cache of every Qloo answer (warmed from the recorded demo), so a repeated
// group never re-spends the hackathon key's small rate budget.
const CACHE = process.env.GROUPTASTE_CACHE;
const tape = {};
if (!fixtures && CACHE) {
  for (const f of [new URL("./fixtures/demo.json", import.meta.url), CACHE]) {
    try { Object.assign(tape, JSON.parse(readFileSync(f, "utf8"))); } catch {}
  }
}
let saveTimer = null;
function remember(key, out) {
  tape[key] = out;
  if (CACHE && !saveTimer) saveTimer = setTimeout(() => { saveTimer = null; writeFileSync(CACHE, JSON.stringify(tape)); }, 500);
}
export const recorded = () => tape;

// The hackathon key has a short burst limit: run Qloo calls one at a time, >=1.2s apart.
let chain = Promise.resolve();
const GAP = Number(process.env.QLOO_GAP_MS || 1200);
function throttled(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, GAP)));
  return run;
}

function qlooApi(args) {
  const key = "api:" + JSON.stringify(args);
  if (tape[key]) return Promise.resolve(tape[key]);
  if (fixtures) {
    if (!(key in fixtures)) return Promise.reject(new Error("fixture miss: " + key));
    return Promise.resolve(fixtures[key]);
  }
  return throttled(() => new Promise((resolve, reject) => {
    execFile("qloo", ["api", ...args], { timeout: 60000, env: process.env }, (err, stdout) => {
      try { const out = JSON.parse(stdout); remember(key, out); resolve(out); } catch { reject(err || new Error("bad qloo output")); }
    });
  }));
}

function qloo(op, input, attempt = 0) {
  const key = op + ":" + JSON.stringify(input);
  if (tape[key]) return Promise.resolve(tape[key]); // same request in this process: don't re-spend quota
  if (fixtures) {
    if (!(key in fixtures)) return Promise.reject(new Error("fixture miss: " + key));
    return Promise.resolve(fixtures[key]);
  }
  // The retry happens OUTSIDE the throttled slot: re-entering throttled() from inside its own
  // job queues behind itself and deadlocks.
  return throttled(() => new Promise((resolve) => {
    execFile("qloo", ["exec", op, "--input", JSON.stringify(input)], { timeout: 60000, env: process.env },
      (err, stdout) => {
        try { resolve({ out: JSON.parse(stdout) }); } catch { resolve({ err: err || new Error("bad qloo output") }); }
      });
  })).then(({ out, err }) => {
    if (err) throw err;
    if (out.error) {
      if (out.error.code === "QLOO_RATE_LIMIT" && attempt < 3) {
        return new Promise((r) => setTimeout(r, 20000 * (attempt + 1))).then(() => qloo(op, input, attempt + 1));
      }
      if (process.env.GT_DEBUG) console.error("QLOO FAIL", op, JSON.stringify(input), JSON.stringify(out).slice(0, 600));
      throw new Error(`${out.error.code}: ${out.error.recovery || ""}`);
    }
    remember(key, out);
    return out;
  });
}

// Resolve a free-text venue to a Qloo place id IN the group's city: search "<name> <city>"
// and keep the first hit whose address mentions the city (fuzzy name match). The harness's own
// ambiguity candidates are popularity-ordered and can be on another continent.
export async function resolveVenue(name, city) {
  const q = (city && !name.toLowerCase().includes(city.toLowerCase())) ? `${name} ${city}` : name;
  const res = await qlooApi(["search", "--query", q, "--type", "place", "--take", "8", "--json"]);
  const list = Array.isArray(res) ? res : res.results || [];
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const core = norm(name).replace(/(nyc|newyork|jazzclub|club|bar|restaurant)$/g, "");
  const inCity = list.filter((x) => !city || ((x.properties?.address || "") + (x.properties?.geocode?.city || ""))
    .toLowerCase().includes(city.toLowerCase().split(",")[0]));
  const named = inCity.filter((x) => norm(x.name).includes(core.slice(0, 6)) || core.includes(norm(x.name).slice(0, 6)));
  const hit = named[0] || null;
  if (!hit) throw new Error(`Couldn't find "${name}" in ${city || "Qloo"} — try the exact venue name.`);
  return { id: hit.entity_id || hit.id, name: hit.name, address: hit.properties?.address || "" };
}

// Resolve a free-text name to one Qloo entity id. The harness returns `needs_input` with
// ranked candidates when a name is ambiguous; prefer the candidate in the requested city,
// else the most popular one. Returns {id,name,address} or null.
export function chooseCandidate(candidates, city) {
  if (!candidates || !candidates.length) return null;
  const c = city ? candidates.filter((x) => (x.address || "").toLowerCase().includes(city.toLowerCase())) : [];
  const pool = c.length ? c : candidates;
  const best = [...pool].sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
  return { id: best.id, name: best.name, address: best.address || "" };
}

async function resolveAll(op, input, fields, city) {
  const out = await qloo(op, input);
  if (out.status !== "needs_input") return { out, input };
  const fixed = structuredClone(input);
  for (const issue of out.resolution?.issues || []) {
    if (!fields.includes(issue.field)) continue;
    const pick = chooseCandidate(issue.candidates, issue.field === "options" ? city : null);
    if (!pick) throw new Error(`Qloo has no match for "${issue.input}"`);
    fixed[issue.field] = fixed[issue.field].map((v) => (v === issue.input ? pick.id : v));
  }
  const again = await qloo(op, fixed);
  if (again.status === "needs_input") throw new Error("Qloo still needs input: " + again.summary);
  return { out: again, input: fixed };
}

// Pull [{id,name,score}] out of a qloo result, whatever the exact envelope nesting is.
export function items(result) {
  const found = [];
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (const x of v) {
        if (x && typeof x === "object" && typeof x.name === "string" &&
            (typeof x.score === "number" || typeof x.affinity === "number")) {
          found.push({ id: x.id || x.entity_id || x.name, name: x.name,
            score: x.score ?? x.affinity ?? (1 / x.rank) });
        } else walk(x);
      }
    } else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(result);
  return found;
}

// The decision uses Qloo's raw affinity (0..1, comparable across members). `shown` is a per-member
// min-max view so the UI can show how much each person prefers one option over another.
export function decide(members, perMember) {
  const venues = new Map();
  perMember.forEach((list, i) => {
    const max = Math.max(...list.map((x) => x.score), 1e-9);
    const min = Math.min(...list.map((x) => x.score));
    const span = max - min > 1e-6 ? max - min : 1;
    for (const x of list) {
      if (!venues.has(x.name)) venues.set(x.name, { name: x.name, scores: Array(members.length).fill(0),
        shown: Array(members.length).fill(0) });
      const v = venues.get(x.name);
      v.scores[i] = x.score;
      v.shown[i] = (x.score - min) / span;
    }
  });
  const rows = [...venues.values()].map((v) => ({
    ...v,
    worst: Math.min(...v.scores),
    mean: v.scores.reduce((a, b) => a + b, 0) / v.scores.length,
  }));
  const fair = [...rows].sort((a, b) => b.worst - a.worst || b.mean - a.mean);
  const loudest = [...rows].sort((a, b) => b.scores[0] - a.scores[0]);
  return { pick: fair[0], ranked: fair, loudestPick: loudest[0] };
}

// Resolve each member's likes ONCE to Qloo entity ids (artist/movie/tv/brand…), so every later
// rank/recommend call is a single request by id instead of a fresh ambiguity round-trip.
const likeCache = new Map();
async function resolveLike(text) {
  if (/^[0-9A-F]{8}-[0-9A-F-]{27}$/i.test(text)) return text;
  if (likeCache.has(text)) return likeCache.get(text);
  const res = await qlooApi(["search", "--query", text, "--take", "3", "--json"]);
  const list = Array.isArray(res) ? res : res.results || [];
  // A "like" is a taste signal (artist, film, show, book, brand…), never a specific venue.
  const hit = list.find((x) => (x.types || []).some((t) => !/album|person|author|place|locality/.test(t)));
  const id = hit ? hit.entity_id || hit.id : null;
  likeCache.set(text, id);
  return id;
}

export async function resolveMembers(members) {
  const out = [];
  for (const m of members) {
    const ids = [];
    for (const l of m.loves.slice(0, 10)) { const id = await resolveLike(l); if (id) ids.push(id); }
    if (!ids.length) throw new Error(`Qloo couldn't match anything ${m.name} loves — try well-known names.`);
    out.push({ ...m, ids });
  }
  return out;
}

// Outing type -> Qloo place category tag (verified tag URNs on the hackathon API).
export const KINDS = {
  bar: "urn:tag:category:place:bar",
  restaurant: "urn:tag:genre:place:restaurant",
  any: null,
};

export async function plan({ members, venues, city, kind = "bar" }) {
  members = await resolveMembers(members);
  const tag = KINDS[kind] ?? null;
  // No venues given: the agent proposes them — each member's top Qloo places in the city,
  // pooled, so the group sees options nobody would have named.
  let places = [];
  if (!venues || !venues.length) {
    const seen = new Set();
    for (const m of members) {
      const r = await resolveAll("recommend", { target_type: "place", signals: m.ids,
        filter_location: city || "New York", ...(tag ? { include_tags: [tag] } : {}),
        limit: Math.max(2, Math.floor(10 / members.length)) }, ["signals"], city);
      // filter_location is a radius, not a city: drop places whose geocode city is elsewhere.
      const want = (city || "New York").toLowerCase().split(",")[0];
      for (const x of r.out.results || []) {
        if ((x.properties?.geocode?.city || want).toLowerCase() !== want) continue;
        if (!seen.has(x.entity_id)) { seen.add(x.entity_id); places.push({ id: x.entity_id, name: x.name,
          address: x.properties?.address || "", proposedFor: m.name }); }
      }
    }
  } else {
    // Resolve venues once, inside the city, so every member is scored on the SAME real places.
    for (const v of venues.slice(0, 10)) places.push(await resolveVenue(v, city));
  }
  places = places.slice(0, 10); // qloo rank accepts at most 10 options
  const venueIds = places.map((p) => p.id);
  const perMember = [];
  for (const m of members) {
    const r = await resolveAll("rank", { options: venueIds, option_type: "place", signals: m.ids },
      ["signals"], city);
    perMember.push(items(r.out));
  }
  const result = decide(members, perMember);
  result.places = places;
  return result;
}

const page = readFileSync(new URL("./index.html", import.meta.url), "utf8");

if (process.argv[1] && process.argv[1].endsWith("server.mjs")) {
  http.createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html" }); return res.end(page);
    }
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200); return res.end(fixtures ? "ok (fixtures)" : "ok (live qloo)");
    }
    if (req.method === "POST" && req.url === "/api/plan") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on("end", async () => {
        try {
          const r = await plan(JSON.parse(body));
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r));
        } catch (e) {
          res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  }).listen(PORT, () => console.log(`grouptaste on :${PORT} ${fixtures ? "(fixtures)" : "(live)"}`));
}
