// Encounter Worship site API (Netlify Function + Netlify Blobs)
// Routes live under /api/*. Admin routes require the ADMIN_PIN environment variable.
import { getStore } from "@netlify/blobs";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

export const config = { path: "/api/*" };

/* ---------- storage (Netlify Blobs, or in-memory for local testing) ---------- */
function db() {
  if (globalThis.__EW_MEM__) {
    const m = globalThis.__EW_MEM__;
    return {
      get: async k => (m.has(k) ? JSON.parse(m.get(k)) : null),
      setJSON: async (k, v) => { m.set(k, JSON.stringify(v)); },
      delete: async k => { m.delete(k); },
      keys: async prefix => [...m.keys()].filter(k => k.startsWith(prefix))
    };
  }
  const s = getStore({ name: "ew-site", consistency: "strong" });
  return {
    get: k => s.get(k, { type: "json" }),
    setJSON: (k, v) => s.setJSON(k, v),
    delete: k => s.delete(k),
    keys: async prefix => (await s.list({ prefix })).blobs.map(b => b.key)
  };
}
async function all(store, prefix) {
  const keys = await store.keys(prefix);
  const rows = await Promise.all(keys.map(k => store.get(k)));
  return rows.filter(Boolean);
}

/* ---------- helpers ---------- */
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (msg, status = 400) => json({ error: msg }, status);
const id = () => randomBytes(6).toString("hex");
const clean = (v, max = 300) => String(v ?? "").trim().slice(0, max);
const phoneOk = p => (String(p).match(/\d/g) || []).length >= 10;
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const ekey = e => createHash("sha256").update(e.toLowerCase()).digest("hex").slice(0, 32);
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const code = (n = 4) => Array.from(randomBytes(n), b => CODE_CHARS[b % CODE_CHARS.length]).join("");
function env(name) {
  try { if (globalThis.Netlify?.env) return Netlify.env.get(name); } catch (e) {}
  return process.env[name];
}
function isAdmin(req) {
  const pin = String(env("ADMIN_PIN") || env("Admin_Pin") || env("admin_pin") || env("ADMIN_Pin") || "").trim();
  if (!pin) return null;
  const got = (req.headers.get("x-admin-pin") || "").trim();
  const a = Buffer.from(createHash("sha256").update(got).digest("hex"));
  const b = Buffer.from(createHash("sha256").update(pin).digest("hex"));
  return timingSafeEqual(a, b);
}
function hashPw(pw, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(pw, salt, 64).toString("hex") };
}
function checkPw(pw, salt, hash) {
  const h = scryptSync(pw, salt, 64);
  const want = Buffer.from(hash, "hex");
  return want.length === h.length && timingSafeEqual(h, want);
}
async function addSubscriber(store, { name, email, source }) {
  const k = "subscribers/" + ekey(email);
  const ex = await store.get(k);
  if (!ex) await store.setJSON(k, { name, email, source, at: new Date().toISOString() });
}
async function sessionMember(store, req) {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!/^[a-f0-9]{48}$/.test(tok)) return null;
  const s = await store.get("sessions/" + tok);
  if (!s || new Date(s.exp) < new Date()) return null;
  const m = await store.get("members/" + ekey(s.email));
  return m ? { m, tok } : null;
}
const publicMember = m => ({ name: m.name, email: m.email, city: m.city, phone: m.phone, interests: m.interests || [], alerts: m.alerts || [], joined: m.joined });

const EVENT_IDS = new Set(["cry-for-our-nation-2026-11-07", "se-2026-11-11", "se-2026-11-18", "se-2026-11-25", "se-2026-12-02"]);
const SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL"];
const DESIGNS = { logo: "EW Logo Tee", worshipper: "Kneeling Worshipper Tee" };
const PRICE = 25;

/* ---------- router ---------- */
export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/\/+$/, "");
  const method = req.method;
  let body = {};
  if (method === "POST") { try { body = await req.json(); } catch (e) { return err("Invalid request"); } }
  const store = db();

  try {
    if (path === "/health") return json({ ok: true });

    /* ----- public: event registration ----- */
    if (path === "/register" && method === "POST") {
      const eventId = clean(body.eventId, 80);
      const name = clean(body.name, 120), email = clean(body.email, 160).toLowerCase();
      if (!EVENT_IDS.has(eventId)) return err("That event isn't open for registration.");
      if (!name || !emailOk(email)) return err("Please enter your name and a valid email.");
      if (!phoneOk(body.phone)) return err("Please enter a phone number with area code.");
      const existing = (await all(store, `regs/${eventId}/`)).find(r => r.email === email);
      if (existing) return json({ reg: { code: existing.code, name: existing.name, eventId }, already: true });
      const reg = { id: id(), eventId, name, email, phone: clean(body.phone, 40), guests: Math.min(10, Math.max(0, parseInt(body.guests) || 0)), how: clean(body.how, 60), newsletter: !!body.newsletter, code: "EW-" + code(), checkedIn: false, checkedInAt: null, source: "online", at: new Date().toISOString() };
      await store.setJSON(`regs/${eventId}/${reg.id}`, reg);
      if (reg.newsletter) await addSubscriber(store, { name, email, source: "registration" });
      return json({ reg: { code: reg.code, name: reg.name, eventId } });
    }

    /* ----- public: shirt pre-order ----- */
    if (path === "/order" && method === "POST") {
      const name = clean(body.name, 120), email = clean(body.email, 160).toLowerCase();
      if (!name || !emailOk(email)) return err("Please enter your name and a valid email.");
      if (!phoneOk(body.phone)) return err("Please enter a phone number with area code.");
      const items = [];
      for (const it of Array.isArray(body.items) ? body.items : []) {
        const qty = Math.min(50, Math.max(0, parseInt(it.qty) || 0));
        if (qty && DESIGNS[it.design] && SIZES.includes(it.size)) items.push({ design: it.design, designName: DESIGNS[it.design], size: it.size, qty });
      }
      if (!items.length) return err("Please choose at least one shirt and size.");
      const count = items.reduce((a, i) => a + i.qty, 0);
      const fulfil = body.fulfil === "ship" ? "ship" : "pickup";
      const order = { id: id(), number: "EWT-" + code(5), name, email, phone: clean(body.phone, 40), items, count, total: count * PRICE, fulfil, address: fulfil === "ship" ? clean(body.address, 400) : "", notes: clean(body.notes, 500), paid: false, at: new Date().toISOString() };
      if (fulfil === "ship" && !order.address) return err("Please enter a shipping address.");
      await store.setJSON(`orders/${order.id}`, order);
      if (body.newsletter) await addSubscriber(store, { name, email, source: "shirt order" });
      return json({ order: { number: order.number, total: order.total, count, items } });
    }

    /* ----- Collective accounts ----- */
    if (path === "/collective/signup" && method === "POST") {
      const name = clean(body.name, 120), email = clean(body.email, 160).toLowerCase(), pw = String(body.password || "");
      if (!name || !emailOk(email)) return err("Please enter your name and a valid email.");
      if (!phoneOk(body.phone)) return err("Please enter a mobile number with area code.");
      if (pw.length < 8) return err("Your password needs at least 8 characters.");
      if (!body.consent) return err("Please agree to receive messages from Encounter Worship.");
      const k = "members/" + ekey(email);
      if (await store.get(k)) return err("An account with this email already exists. Please sign in.", 409);
      const { salt, hash } = hashPw(pw);
      const m = { name, email, city: clean(body.city, 80), phone: clean(body.phone, 40), interests: (Array.isArray(body.interests) ? body.interests : []).map(x => clean(x, 60)).slice(0, 6), alerts: ["Email"], salt, hash, joined: new Date().toISOString() };
      await store.setJSON(k, m);
      await addSubscriber(store, { name, email, source: "collective" });
      const tok = randomBytes(24).toString("hex");
      await store.setJSON("sessions/" + tok, { email, exp: new Date(Date.now() + 30 * 864e5).toISOString() });
      return json({ token: tok, member: publicMember(m) });
    }
    if (path === "/collective/login" && method === "POST") {
      const email = clean(body.email, 160).toLowerCase(), pw = String(body.password || "");
      const m = await store.get("members/" + ekey(email));
      if (!m || !checkPw(pw, m.salt, m.hash)) return err("That email and password don't match. Please try again.", 401);
      const tok = randomBytes(24).toString("hex");
      await store.setJSON("sessions/" + tok, { email, exp: new Date(Date.now() + 30 * 864e5).toISOString() });
      return json({ token: tok, member: publicMember(m) });
    }
    if (path === "/collective/logout" && method === "POST") {
      const s = await sessionMember(store, req);
      if (s) await store.delete("sessions/" + s.tok);
      return json({ ok: true });
    }
    if (path === "/collective/me") {
      const s = await sessionMember(store, req);
      if (!s) return err("Please sign in.", 401);
      return json({ member: publicMember(s.m) });
    }
    if (path === "/collective/prefs" && method === "POST") {
      const s = await sessionMember(store, req);
      if (!s) return err("Please sign in.", 401);
      s.m.alerts = (Array.isArray(body.alerts) ? body.alerts : []).filter(a => ["Email", "Text message"].includes(a));
      await store.setJSON("members/" + ekey(s.m.email), s.m);
      return json({ member: publicMember(s.m) });
    }
    if (path === "/collective/password" && method === "POST") {
      const s = await sessionMember(store, req);
      if (!s) return err("Please sign in.", 401);
      if (!checkPw(String(body.current || ""), s.m.salt, s.m.hash)) return err("Your current password isn't right.", 401);
      if (String(body.next || "").length < 8) return err("Your new password needs at least 8 characters.");
      Object.assign(s.m, hashPw(String(body.next)));
      await store.setJSON("members/" + ekey(s.m.email), s.m);
      return json({ ok: true });
    }
    if (path === "/collective/prayer" && method === "POST") {
      const s = await sessionMember(store, req);
      if (!s) return err("Please sign in.", 401);
      const text = clean(body.text, 1000);
      if (!text) return err("Please write your prayer request.");
      await store.setJSON("prayers/" + id(), { name: s.m.name, email: s.m.email, text, at: new Date().toISOString() });
      return json({ ok: true });
    }

    /* ----- admin (door team) ----- */
    if (path.startsWith("/admin/")) {
      const ok = isAdmin(req);
      if (ok === null) return err("The ADMIN_PIN setting is missing in Netlify. Add it under Environment variables and redeploy.", 503);
      if (!ok) return err("That PIN isn't right.", 401);
      if (path === "/admin/check") return json({ ok: true });
      if (path === "/admin/regs") {
        const eventId = url.searchParams.get("eventId") || "";
        const regs = (await all(store, `regs/${eventId}/`)).sort((a, b) => a.name.localeCompare(b.name));
        return json({ regs });
      }
      if (path === "/admin/checkin" && method === "POST") {
        const k = `regs/${clean(body.eventId, 80)}/${clean(body.id, 20)}`;
        const r = await store.get(k);
        if (!r) return err("Guest not found.", 404);
        r.checkedIn = !!body.checked; r.checkedInAt = r.checkedIn ? new Date().toISOString() : null;
        await store.setJSON(k, r);
        return json({ reg: r });
      }
      if (path === "/admin/newsletter" && method === "POST") {
        const k = `regs/${clean(body.eventId, 80)}/${clean(body.id, 20)}`;
        const r = await store.get(k);
        if (!r) return err("Guest not found.", 404);
        r.newsletter = true; await store.setJSON(k, r);
        await addSubscriber(store, { name: r.name, email: r.email, source: "check-in" });
        return json({ reg: r });
      }
      if (path === "/admin/walkin" && method === "POST") {
        const eventId = clean(body.eventId, 80);
        const name = clean(body.name, 120), email = clean(body.email, 160).toLowerCase();
        if (!EVENT_IDS.has(eventId)) return err("Unknown event.");
        if (!name) return err("Please enter a name.");
        if (!phoneOk(body.phone)) return err("Please enter a phone number with area code.");
        if (email && !emailOk(email)) return err("That email doesn't look right.");
        const reg = { id: id(), eventId, name, email, phone: clean(body.phone, 40), guests: Math.min(10, Math.max(0, parseInt(body.guests) || 0)), newsletter: !!body.newsletter && !!email, code: "EW-" + code(), checkedIn: true, checkedInAt: new Date().toISOString(), source: "door", at: new Date().toISOString() };
        await store.setJSON(`regs/${eventId}/${reg.id}`, reg);
        if (reg.newsletter) await addSubscriber(store, { name, email, source: "walk-in" });
        return json({ reg });
      }
      if (path === "/admin/orders") return json({ orders: (await all(store, "orders/")).sort((a, b) => b.at.localeCompare(a.at)) });
      if (path === "/admin/order-paid" && method === "POST") {
        const k = `orders/${clean(body.id, 20)}`;
        const o = await store.get(k);
        if (!o) return err("Order not found.", 404);
        o.paid = !!body.paid; o.paidAt = o.paid ? new Date().toISOString() : null;
        await store.setJSON(k, o);
        return json({ order: o });
      }
      if (path === "/admin/people") {
        const members = (await all(store, "members/")).map(publicMember);
        const subscribers = await all(store, "subscribers/");
        const prayers = (await all(store, "prayers/")).sort((a, b) => b.at.localeCompare(a.at));
        return json({ members, subscribers, prayers });
      }
    }
    return err("Not found", 404);
  } catch (e) {
    console.error(e);
    return err("Something went wrong on our side. Please try again.", 500);
  }
};
