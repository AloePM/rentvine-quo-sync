import fetch from "node-fetch";
import fs from "fs";

const RENTVINE_BASE = "https://aloepm.rentvine.com/api/manager";
const RENTVINE_AUTH = "Basic " + Buffer.from(process.env.RENTVINE_KEY + ":" + process.env.RENTVINE_SECRET).toString("base64");
const QUO_API_KEY   = process.env.QUO_API_KEY;
const QUO_BASE      = "https://api.openphone.com/v1";
const TYPES         = ["owners", "tenants", "vendors", "associations"];
const TAG_KEY       = "1724271238010";
const PROP_KEYS     = ["6a726c1c0bd9d6a0c43aff2f","6a726c250bd9d6a0c43aff3d","6a726c2b0bd9d6a0c43aff4a","6a726c310bd9d6a0c43aff54","6a726da60bd9d6a0c43aff88","6a726dac0bd9d6a0c43aff8e"];
const QUO_HEADERS   = { Authorization: QUO_API_KEY, "Content-Type": "application/json" };
const GCS_BUCKET    = process.env.GCS_BUCKET || "aloe-pm-sync-cache";
const GCS_CACHE_KEY = "quo-id-cache.json";
const sleep         = ms => new Promise(r => setTimeout(r, ms));
let idCache         = {};

async function loadCache() {
  try {
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage();
    const [contents] = await storage.bucket(GCS_BUCKET).file(GCS_CACHE_KEY).download();
    idCache = JSON.parse(contents.toString());
    console.log("Loaded GCS cache: " + Object.keys(idCache).length + " entries");
  } catch(e) {
    console.log("No existing cache found, starting fresh");
  }
}

async function saveCache() {
  try {
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage();
    await storage.bucket(GCS_BUCKET).file(GCS_CACHE_KEY).save(JSON.stringify(idCache));
    console.log("Cache saved to GCS: " + Object.keys(idCache).length + " entries");
  } catch(e) {
    console.error("Cache save error:", e.message);
  }
}

async function rvGet(path) {
  const res = await fetch(RENTVINE_BASE + path, { headers: { Authorization: RENTVINE_AUTH, Accept: "application/json" } });
  if (!res.ok) throw new Error("RV " + path + " => " + res.status);
  return res.json();
}

// Build owner address map from properties export
async function buildOwnerAddressMap() {
  const map = {};
  console.log("Building owner address map...");
  let page = 1;
  while (true) {
    const json = await rvGet("/properties/export?page=" + page + "&pageSize=250");
    const rows = Array.isArray(json) ? json : (json.data ?? []);
    for (const row of rows) {
      const p = row.property ?? {}, port = row.portfolio ?? {};
      const owners = port.contacts ?? port.owners ?? [];
      if (p.isActive !== "1") continue;
      const addr = [p.address, p.city, p.stateID, p.postalCode].filter(Boolean).join(", ");
      if (!addr) continue;
      for (const o of owners) {
        const cid = String(o.contactID);
        if (!map[cid]) map[cid] = [];
        if (!map[cid].includes(addr)) map[cid].push(addr);
      }
    }
    console.log("  Properties page " + page + ": " + rows.length);
    if (rows.length < 250) break;
    page++;
  }
  console.log("Owner map: " + Object.keys(map).length + " owners");
  return map;
}

// Build tenant map from lease export — gets address, email AND phone from lease
async function buildTenantLeaseMap() {
  const addrMap    = {}; // contactID -> unit/property address
  const contactMap = {}; // contactID -> { email, phone }
  console.log("Building tenant lease map...");
  let page = 1;
  while (true) {
    const json = await rvGet("/leases/export?primaryLeaseStatusIDs[]=1&primaryLeaseStatusIDs[]=2&primaryLeaseStatusIDs[]=3&page=" + page + "&pageSize=250");
    const arr = Array.isArray(json) ? json : (json.data ?? []);
    for (const row of arr) {
      const u = row.unit, p = row.property;
      const addr = u ? [u.address, u.city, u.stateID, u.postalCode].filter(Boolean).join(", ")
                     : p ? [p.address, p.city, p.stateID, p.postalCode].filter(Boolean).join(", ") : "";
      for (const t of row.lease?.tenants ?? []) {
        if (!t.contactID) continue;
        const cid = String(t.contactID);
        if (addr && !addrMap[cid]) addrMap[cid] = addr;
        if (!contactMap[cid]) contactMap[cid] = {};
        if (t.email && !contactMap[cid].email) contactMap[cid].email = t.email;
        if (t.phone && !contactMap[cid].phone) contactMap[cid].phone = t.phone;
      }
    }
    console.log("  Leases page " + page + ": " + arr.length);
    if (arr.length < 250) break;
    page++;
  }
  console.log("Tenant lease map: " + Object.keys(addrMap).length + " addresses, " + Object.keys(contactMap).length + " contacts");
  return { addrMap, contactMap };
}

async function fetchAll(type) {
  const all = []; let page = 1;
  console.log("Fetching " + type + "...");
  while (true) {
    const json = await rvGet("/" + type + "?page=" + page + "&pageSize=250");
    const rows = (Array.isArray(json) ? json : (json.data ?? [])).map(i => i.contact ?? i);
    all.push(...rows); if (rows.length < 250) break; page++;
  }
  return all;
}

async function findInQuo(externalId) {
  if (idCache[externalId]) return { id: idCache[externalId] };
  const res = await fetch(QUO_BASE + "/contacts?externalIds[]=" + encodeURIComponent(externalId) + "&maxResults=1", { headers: QUO_HEADERS });
  if (!res.ok) return null;
  const matches = ((await res.json()).data ?? []).filter(c => c.externalId === externalId);
  if (matches[0]) { idCache[externalId] = matches[0].id; return matches[0]; }
  return null;
}

async function upsertToQuo(contact, type, addresses, leaseContactMap) {
  const isBiz = type === "vendors" || type === "associations";
  const hasName = contact.firstName || contact.lastName;
  const company = (isBiz && !hasName) ? (contact.name || contact.taxPayerName || "") : (contact.taxPayerName || contact.name || "");
  const role = type[0].toUpperCase() + type.slice(1, -1);
  const externalId = "rentvine-" + type + "-" + contact.contactID;

  // For tenants, use lease export email/phone (more complete than contact record)
  const leaseInfo = (type === "tenants") ? (leaseContactMap[String(contact.contactID)] ?? {}) : {};
  const email = leaseInfo.email || contact.email;
  const phone = leaseInfo.phone || contact.phone;

  const customFields = [{ key: TAG_KEY, value: [role] }];
  for (let i = 0; i < Math.min(addresses.length, PROP_KEYS.length); i++) {
    customFields.push({ key: PROP_KEYS[i], value: addresses[i] });
  }

  const payload = {
    externalId, source: "rentvine", sourceUrl: "https://aloepm.rentvine.com",
    defaultFields: {
      firstName: (isBiz && !hasName) ? company : (contact.firstName ?? ""),
      lastName:  (isBiz && !hasName) ? "" : (contact.lastName ?? ""),
      role, company: company || null,
      emails:       email ? [{ name: "Email", value: email }] : [],
      phoneNumbers: phone ? [{ name: "Phone", value: phone }] : [],
    },
    customFields
  };

  const existing = await findInQuo(externalId);
  if (existing) {
    const r = await fetch(QUO_BASE + "/contacts/" + existing.id, { method: "PATCH", headers: QUO_HEADERS, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error("update " + r.status + " " + await r.text());
    idCache[externalId] = existing.id;
    return "updated";
  }
  const r = await fetch(QUO_BASE + "/contacts", { method: "POST", headers: QUO_HEADERS, body: JSON.stringify(payload) });
  if (r.status === 409) return "skipped";
  if (!r.ok) throw new Error("create " + r.status + " " + await r.text());
  const created = await r.json();
  if (created.data?.id) idCache[externalId] = created.data.id;
  return "created";
}

async function main() {
  console.log("Rentvine -> Quo sync starting");
  await loadCache();
  const summary = { created: 0, updated: 0, skipped: 0, failed: 0 };

  const ownerAddressMap            = await buildOwnerAddressMap();
  const { addrMap: tenantAddrMap, contactMap: tenantContactMap } = await buildTenantLeaseMap();

  for (const type of TYPES) {
    let contacts;
    try { contacts = await fetchAll(type); }
    catch (e) { console.error("Fetch " + type + " failed: " + e.message); continue; }

    console.log("Upserting " + contacts.length + " " + type + "...");

    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      const cid = String(c.contactID ?? c.id ?? "");
      let addresses = [];
      if (type === "owners")  addresses = ownerAddressMap[cid] ?? [];
      if (type === "tenants") { const a = tenantAddrMap[cid]; if (a) addresses = [a]; }

      try {
        const action = await upsertToQuo(c, type, addresses, tenantContactMap);
        summary[action]++;
        if ((i + 1) % 50 === 0 || i === contacts.length - 1) {
          console.log("[" + (i+1) + "/" + contacts.length + "] " + action + " rentvine-" + type + "-" + cid + (addresses.length ? " | " + addresses.length + " addr" : ""));
        }
      } catch (e) {
        summary.failed++;
        console.error("FAIL rentvine-" + type + "-" + cid + ": " + e.message);
      }
      await sleep(150);
    }
  }

  saveCache();
  console.log("SYNC COMPLETE created:" + summary.created + " updated:" + summary.updated + " skipped:" + summary.skipped + " failed:" + summary.failed + " cache:" + Object.keys(idCache).length);
  process.exit(0);
}
main().catch(e => { console.error("Fatal:", e); process.exit(1); });
