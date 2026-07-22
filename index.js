import fetch from "node-fetch";

const RENTVINE_BASE = "https://aloepm.rentvine.com/api/manager";
const RENTVINE_AUTH = "Basic " + Buffer.from(process.env.RENTVINE_KEY + ":" + process.env.RENTVINE_SECRET).toString("base64");
const QUO_API_KEY   = process.env.QUO_API_KEY;
const QUO_BASE      = "https://api.openphone.com/v1";
const TYPES         = ["owners", "tenants", "vendors", "associations"];
const ADDR_KEY      = "1711655593845";
const sleep         = ms => new Promise(r => setTimeout(r, ms));

// ─── RENTVINE FETCHERS ───────────────────────────────────────────────────────

async function fetchAll(type) {
  const all = []; let page = 1;
  console.log("Fetching " + type + "...");
  while (true) {
    const res = await fetch(RENTVINE_BASE + "/" + type + "?page=" + page + "&pageSize=250", {
      headers: { Authorization: RENTVINE_AUTH, Accept: "application/json" }
    });
    if (!res.ok) throw new Error("Rentvine " + type + " p" + page + ": " + res.status);
    const json = await res.json();
    const rows = (Array.isArray(json) ? json : (json.data ?? [])).map(i => i.contact ?? i);
    all.push(...rows);
    console.log("  Page " + page + ": " + rows.length + " (total " + all.length + ")");
    if (rows.length < 250) break;
    page++;
  }
  return all;
}

// Build map of ownerContactID -> [property addresses]
async function buildOwnerPropertyMap() {
  console.log("Building owner->property map...");
  const map = {};
  let page = 1;
  while (true) {
    const res = await fetch(RENTVINE_BASE + "/properties/export?page=" + page + "&pageSize=250", {
      headers: { Authorization: RENTVINE_AUTH, Accept: "application/json" }
    });
    if (!res.ok) break;
    const json = await res.json();
    const rows = Array.isArray(json) ? json : (json.data ?? []);
    for (const row of rows) {
      const p = row.property;
      const owners = row.portfolio?.owners ?? [];
      const addr = [p.address, p.city, p.stateID, p.postalCode].filter(Boolean).join(", ");
      for (const owner of owners) {
        const cid = String(owner.contactID);
        if (!map[cid]) map[cid] = [];
        if (addr && !map[cid].includes(addr)) map[cid].push(addr);
      }
    }
    console.log("  Properties page " + page + ": " + rows.length);
    if (rows.length < 250) break;
    page++;
  }
  console.log("Owner property map built for " + Object.keys(map).length + " owners");
  return map;
}

// Build map of tenantContactID -> lease property address
async function buildTenantPropertyMap() {
  console.log("Building tenant->property map...");
  const map = {};
  let page = 1;
  while (true) {
    const res = await fetch(RENTVINE_BASE + "/leases/export?primaryLeaseStatusIDs[]=2&page=" + page + "&pageSize=250", {
      headers: { Authorization: RENTVINE_AUTH, Accept: "application/json" }
    });
    if (!res.ok) break;
    const json = await res.json();
    const rows = Array.isArray(json) ? json : (json.data ?? []);
    for (const row of rows) {
      const unit = row.unit;
      const prop = row.property;
      const lease = row.lease;
      const tenants = lease?.tenants ?? [];
      if (tenants.length === 0) continue;
      const addr = unit ? [unit.address, unit.city, unit.stateID, unit.postalCode].filter(Boolean).join(", ")
                        : prop ? [prop.address, prop.city, prop.stateID, prop.postalCode].filter(Boolean).join(", ") : "";
      for (const tenant of tenants) {
        if (addr && tenant.contactID) map[String(tenant.contactID)] = addr;
      }
    }
    console.log("  Leases page " + page + ": " + rows.length);
    if (rows.length < 250) break;
    page++;
  }
  console.log("Tenant property map built for " + Object.keys(map).length + " tenants");
  return map;
}

// ─── QUO ────────────────────────────────────────────────────────────────────

const QUO_HEADERS = { Authorization: QUO_API_KEY, "Content-Type": "application/json" };

async function findByExternalId(externalId) {
  const res = await fetch(QUO_BASE + "/contacts?externalIds[]=" + encodeURIComponent(externalId) + "&maxResults=1", { headers: QUO_HEADERS });
  if (!res.ok) return null;
  const json = await res.json();
  // Verify exact match since Quo may return partial matches
  const contacts = (json.data ?? []).filter(c => c.externalId === externalId);
  return contacts[0] ?? null;
}

async function createContact(payload) {
  const res = await fetch(QUO_BASE + "/contacts", { method: "POST", headers: QUO_HEADERS, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error("create " + res.status + " " + await res.text());
}

async function updateContact(id, payload) {
  const res = await fetch(QUO_BASE + "/contacts/" + id, { method: "PATCH", headers: QUO_HEADERS, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error("update " + res.status + " " + await res.text());
}

// ─── PAYLOAD ────────────────────────────────────────────────────────────────

function buildPayload(c, type, propertyAddress) {
  const role    = type.charAt(0).toUpperCase() + type.slice(1, -1);
  const isBusinessType = type === "vendors" || type === "associations";
  const hasPersonName = c.firstName || c.lastName;
  const company = (isBusinessType && !hasPersonName) ? (c.name || c.taxPayerName || "") : (c.taxPayerName || c.name || "");
  return {
    externalId: "rentvine-" + type + "-" + (c.contactID ?? c.id),
    source: "rentvine",
    sourceUrl: "https://aloepm.rentvine.com",
    defaultFields: {
      firstName: (isBusinessType && !hasPersonName) ? company : (c.firstName ?? ""),
      lastName: (isBusinessType && !hasPersonName) ? "" : (c.lastName ?? ""),
      role,
      company: company || null,
      emails: c.email ? [{ name: "Email", value: c.email }] : [],
      phoneNumbers: c.phone ? [{ name: "Phone", value: c.phone }] : [],
    },
    customFields: [
      ...(propertyAddress ? [{ key: ADDR_KEY, value: propertyAddress }] : []),
      { key: "1724271238010", value: [role] }
    ]
  };
}

// ─── UPSERT ─────────────────────────────────────────────────────────────────

async function findByPhone(phone) {
  if (!phone) return null;
  // Normalize phone to E.164
  const normalized = phone.replace(/[^+\d]/g, '');
  const res = await fetch(QUO_BASE + "/contacts?phoneNumber=" + encodeURIComponent(normalized) + "&maxResults=5", { headers: QUO_HEADERS });
  if (!res.ok) return null;
  const json = await res.json();
  const contacts = (json.data ?? []);
  // Return first contact that matches phone and has no externalId (manually added duplicate)
  return contacts.find(c => !c.externalId || c.externalId === '') ?? null;
}

async function upsert(contact, type, propertyAddress) {
  const payload = buildPayload(contact, type, propertyAddress);
  let existing = await findByExternalId(payload.externalId);
  let matchedBy = "externalId";
  if (existing) {
    await updateContact(existing.id, payload);
    return { action: "updated", matchedBy };
  }
  // Fallback: match by phone number to merge duplicates
  const phone = payload.defaultFields?.phoneNumbers?.[0]?.value;
  if (phone) {
    const phoneMatch = await findByPhone(phone);
    if (phoneMatch) {
      await updateContact(phoneMatch.id, payload);
      return { action: "merged", matchedBy: "phone" };
    }
  }
  await createContact(payload);
  return { action: "created", matchedBy: "none" };
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("Rentvine -> Quo sync starting");
  const summary = { created: 0, updated: 0, merged: 0, failed: 0 };

  // Pre-build address maps
  const ownerPropMap  = await buildOwnerPropertyMap();
  const tenantPropMap = await buildTenantPropertyMap();

  for (const type of TYPES) {
    let contacts;
    try { contacts = await fetchAll(type); }
    catch (e) { console.error("Fetch " + type + " failed: " + e.message); continue; }

    console.log("Upserting " + contacts.length + " " + type + "...");

    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      const cid = String(c.contactID ?? c.id ?? "");

      // Get property address based on contact type
      let propertyAddress = "";
      if (type === "owners") {
        const addrs = ownerPropMap[cid] ?? [];
        propertyAddress = addrs.join(" | ");  // multiple properties separated by pipe
      } else if (type === "tenants") {
        propertyAddress = tenantPropMap[cid] ?? "";
      }

      try {
        const { action, matchedBy } = await upsert(c, type, propertyAddress);
        summary[action]++;
      
        if ((i + 1) % 50 === 0 || i === contacts.length - 1)
          console.log("  [" + (i+1) + "/" + contacts.length + "] " + action + " by " + matchedBy + (propertyAddress ? " | addr: " + propertyAddress.substring(0,40) : ""));
      } catch (e) {
        summary.failed++;
        console.error("  FAIL rentvine-" + type + "-" + cid + ": " + e.message);
      }
      await sleep(150);
    }
  }

  console.log("SYNC COMPLETE created:" + summary.created + " updated:" + summary.updated + " failed:" + summary.failed);
  process.exit(0);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
