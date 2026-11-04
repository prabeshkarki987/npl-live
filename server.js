// NPL Live Score - backend
// Serves the website and a cached JSON API at /api/matches.
// No npm packages needed (Node 18+).
//
// Data source: CricketData.org (cricapi.com). Only the functions in
// "adapter" talk to the API, so you can swap in another provider later.

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---- tiny .env loader ----
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (_) {}

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.CRICAPI_KEY || "";
const SERIES_ID = process.env.NPL_SERIES_ID || "";
const SERIES_SEARCH = process.env.NPL_SERIES_SEARCH || "Nepal Premier League";
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS || 60);
const DEMO = process.env.DEMO === "1" || !API_KEY;
const BASE = "https://api.cricapi.com/v1";

// ---------- adapter: CricketData.org ----------
async function api(endpoint, params = {}) {
  const url = new URL(`${BASE}/${endpoint}`);
  url.searchParams.set("apikey", API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "User-Agent": "npl-live-score" } });
  if (!res.ok) throw new Error(`API ${endpoint} HTTP ${res.status}`);
  const json = await res.json();
  if (json.status && json.status !== "success") throw new Error(`API ${endpoint}: ${json.reason || json.status}`);
  return json.data;
}

let seriesIdCache = SERIES_ID;
async function findSeriesId() {
  if (seriesIdCache) return seriesIdCache;
  const list = await api("series", { offset: 0, search: SERIES_SEARCH });
  const wanted = (list || []).filter((s) => /nepal premier league/i.test(s.name));
  // newest first by start date if available
  wanted.sort((a, b) => String(b.startDate || "").localeCompare(String(a.startDate || "")));
  if (!wanted.length) throw new Error("NPL series not found. Set NPL_SERIES_ID in .env");
  seriesIdCache = wanted[0].id;
  return seriesIdCache;
}

function normalize(m, scoreById) {
  const teams = (m.teamInfo && m.teamInfo.length ? m.teamInfo : (m.teams || []).map((n) => ({ name: n, shortname: n.slice(0, 3).toUpperCase() })))
    .map((t) => ({ name: t.name, short: t.shortname || t.name.slice(0, 3).toUpperCase(), img: t.img || "" }));
  const live = scoreById[m.id];
  const scores = (live ? live.score : m.score || []).map((s) => ({
    inning: s.inning || "", runs: s.r, wickets: s.w, overs: s.o,
  }));
  let state = "upcoming";
  if (m.matchEnded) state = "result";
  else if (m.matchStarted) state = "live";
  return {
    id: m.id, name: m.name, state, status: (live && live.status) || m.status || "",
    venue: m.venue || "", start: m.dateTimeGMT ? m.dateTimeGMT + (m.dateTimeGMT.endsWith("Z") ? "" : "Z") : m.date,
    teams, scores,
  };
}

async function fetchLive() {
  const sid = await findSeriesId();
  const [info, current] = await Promise.all([
    api("series_info", { id: sid }),
    api("currentMatches", { offset: 0 }).catch(() => []),
  ]);
  const scoreById = {};
  for (const c of current || []) scoreById[c.id] = c;
  const list = (info.matchList || []).map((m) => normalize(m, scoreById));
  return { series: info.info ? info.info.name : SERIES_SEARCH, matches: list };
}

// ---------- demo data (clearly labelled sample) ----------
function demoData() {
  const now = Date.now();
  const iso = (h) => new Date(now + h * 3600e3).toISOString();
  const T = {
    SUD: { name: "Sudurpaschim Royals", short: "SUD" },
    CHI: { name: "Chitwan Rhinos", short: "CHI" },
    BIR: { name: "Biratnagar Kings", short: "BIR" },
    JAN: { name: "Janakpur Bolts", short: "JAN" },
  };
  const mk = (id, a, b, state, h, status, scores, venue = "TU Cricket Ground, Kirtipur") => ({
    id, name: `${T[a].name} vs ${T[b].name}`, state, status, venue, start: iso(h),
    teams: [T[a], T[b]], scores,
  });
  return {
    demo: true,
    series: "Nepal Premier League (SAMPLE DATA)",
    matches: [
      mk("d1", "SUD", "CHI", "result", -26, "Sudurpaschim Royals won by 5 wickets",
        [{ inning: "Chitwan Rhinos Inning 1", runs: 151, wickets: 8, overs: 20 }, { inning: "Sudurpaschim Royals Inning 1", runs: 152, wickets: 5, overs: 18.4 }]),
      mk("d2", "BIR", "JAN", "live", -1.2, "Biratnagar Kings need 41 runs from 30 balls",
        [{ inning: "Janakpur Bolts Inning 1", runs: 168, wickets: 7, overs: 20 }, { inning: "Biratnagar Kings Inning 1", runs: 128, wickets: 4, overs: 15 }]),
      mk("d3", "CHI", "BIR", "upcoming", 22, "Match not started", []),
      mk("d4", "JAN", "SUD", "upcoming", 46, "Match not started", []),
    ],
  };
}

// ---------- scorecard (match details) ----------
function normalizeCard(d) {
  const innings = (d.scorecard || []).map((s) => ({
    name: s.inning || "",
    batting: (s.batting || []).map((b) => ({
      name: (b.batsman && b.batsman.name) || "",
      out: b["dismissal-text"] || b.dismissal || "",
      r: b.r, b: b.b, fours: b["4s"], sixes: b["6s"], sr: b.sr,
    })),
    bowling: (s.bowling || []).map((b) => ({
      name: (b.bowler && b.bowler.name) || "",
      o: b.o, m: b.m, r: b.r, w: b.w, eco: b.eco,
    })),
  }));
  return {
    id: d.id, name: d.name || "", status: d.status || "", venue: d.venue || "",
    date: d.dateTimeGMT ? d.dateTimeGMT + (String(d.dateTimeGMT).endsWith("Z") ? "" : "Z") : d.date || "",
    toss: d.tossWinner ? `${d.tossWinner} chose to ${d.tossChoice || ""}`.trim() : "",
    winner: d.matchWinner || "",
    innings,
  };
}

function demoCard(id) {
  const bat = (n, out, r, b, f, s) => ({ name: `Batter ${n}`, out, r, b, fours: f, sixes: s, sr: +(r / b * 100).toFixed(2) });
  const bowl = (n, o, m, r, w) => ({ name: `Bowler ${n}`, o, m, r, w, eco: +(r / o).toFixed(2) });
  const base = { id, venue: "TU Cricket Ground, Kirtipur", toss: "Toss: sample data", winner: "" };
  const inn1 = {
    name: "Janakpur Bolts Inning 1",
    batting: [bat(1, "c Fielder 3 b Bowler 1", 42, 31, 5, 2), bat(2, "lbw b Bowler 2", 28, 22, 3, 1), bat(3, "not out", 55, 38, 4, 3), bat(4, "b Bowler 1", 12, 9, 1, 0)],
    bowling: [bowl(1, 4, 0, 31, 2), bowl(2, 4, 0, 36, 1), bowl(3, 4, 0, 40, 0)],
  };
  const inn2 = {
    name: "Biratnagar Kings Inning 1",
    batting: [bat(1, "c Fielder 1 b Bowler 4", 37, 26, 4, 2), bat(2, "not out", 48, 33, 5, 1), bat(3, "run out", 19, 15, 2, 0)],
    bowling: [bowl(4, 4, 0, 29, 2), bowl(5, 3, 0, 27, 1)],
  };
  return { ...base, name: "Sample match (SAMPLE DATA)", status: "Sample scorecard. Real names appear when the live API is on.", innings: [inn1, inn2], demo: true };
}

const cardCache = new Map(); // id -> {at, data}
async function getCard(id) {
  if (DEMO) return demoCard(id);
  const hit = cardCache.get(id);
  const done = (c) => /won|tied|no result|abandon/i.test(c.status || "");
  if (hit && Date.now() - hit.at < (done(hit.data) ? 600 : CACHE_SECONDS) * 1000) return hit.data;
  try {
    const data = normalizeCard(await api("match_scorecard", { id }));
    cardCache.set(id, { at: Date.now(), data });
    if (cardCache.size > 200) cardCache.delete(cardCache.keys().next().value);
    return data;
  } catch (e) {
    if (hit) return { ...hit.data, stale: true };
    throw e;
  }
}

// ---------- cache ----------
let cache = { at: 0, data: null, error: null };
let inflight = null;
async function getData() {
  if (DEMO) return demoData();
  if (cache.data && Date.now() - cache.at < CACHE_SECONDS * 1000) return cache.data;
  if (!inflight) {
    inflight = fetchLive()
      .then((d) => { cache = { at: Date.now(), data: { ...d, updated: new Date().toISOString() }, error: null }; })
      .catch((e) => { cache.error = e.message; console.error("fetch failed:", e.message); })
      .finally(() => { inflight = null; });
  }
  await inflight;
  if (!cache.data) throw new Error(cache.error || "No data");
  return { ...cache.data, stale: Boolean(cache.error), error: cache.error };
}

// ---------- static + routes ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/matches") {
    try {
      const d = await getData();
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ updated: new Date().toISOString(), ...d }));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/match") {
    const id = url.searchParams.get("id") || "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "bad id" })); }
    try {
      const d = await getCard(id);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(d));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  let file = path.normalize(path.join(__dirname, "public", url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(path.join(__dirname, "public"))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`NPL Live Score on http://localhost:${PORT}  [${DEMO ? "DEMO mode" : "live API"}]`));
