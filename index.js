import fetch from "node-fetch";

const RENTVINE_BASE = "https://aloepm.rentvine.com/api/manager";
const RENTVINE_AUTH = "Basic " + Buffer.from(`${process.env.RENTVINE_KEY}:${process.env.RENTVINE_SECRET}`).toString("base64");
const QUO_API_KEY   = process.env.QUO_API_KEY;
const QUO_BASE      = "https://api.openphone.com/v1";
const TYPES         = ["owners", "tenants", "vendors", "associations"];
const sleep         = ms => new Promise(r => setTimeout(r, ms));

// ─── RENTVINE ────────────────────────────────────────────────────────────────

async function fetchAll(type) {
  const all = []; let page = 1;
  console.log(`\n📥 Fetching ${type}...`);
  while (true) {
    const res = await fetch(`${RENTVINE_BASE}/${type}?page=${page}&pageSize=250`, {
      headers: { Authorization: RENTVINE_AUTH, Accept: "application/json" }
    });
    if (!res.ok) throw new Error(`Rentvine ${type} p${page}: ${res.status}`);
    const json = await res.json();
    const rows = (Array.isArray(json) ? json : (json.data ?? [])).map(i => i.contact ?? i);
    all.push(...rows);
    console.log(`  Page ${page}: ${rows.length} (total ${all.length})`);
    if (rows.length < 250) break;
    page++;
  }
  return all;
}

// ─── QUO ─────────────────────────────────────────────────────────────────────

const QUO_HEADERS = { Authorization: QUO_API_KEY, "Content-Type": "application/json" };

// Search Quo contacts by phone number
async function findByPhone(phone) {
  if (!phone) return null;
  const res = await fetch(
    `${QUO_BASE}/contacts?phoneNumber=${encodeURIComponent(phone)}`,
    { headers: QUO_HEADERS }
  );
  if (!res.ok) return null;
  const json = await res.json();
  const list = json.data ?? [];
  return list.length > 0 ? list[0] : null;
}

// Search Quo contacts by externalId (for contacts we've synced before)
async function findByExternalId(externalId) {
  const res = await fetch(
    `${QUO_BASE}/contacts?externalId=${encodeURIComponent(externalId)}`,
    { headers: QUO_HEADERS }
  );
  if (!res.ok) return null;
  const json = await res.json();
  const list = json.data ?? [];
  return list.length > 0 ? list[0] : null;
}

async function createContact(payload) {
  const res = await fetch(`${QUO_BASE}/contacts`, {
    method: "POST",
    headers: QUO_HEADERS,
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`create ${res.status} ${await res.text()}`);
  return res.json();
}

async function updateContact(id, payload) {
  const res = await fetch(`${QUO_BASE}/contacts/${id}`, {
    method: "PATCH",
    headers: QUO_HEADERS,
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`update ${res.status} ${await res.text()}`);
  return res.json();
}

// ─── MAPPING ─────────────────────────────────────────────────────────────────

function buildPayload(c, type) {
  const role    = type.charAt(0).toUpperCase() + type.slice(1, -1);
  const company = c.taxPayerName && c.taxPayerName !== c.name ? c.taxPayerName : "";
  return {
    externalId: `rentvine-${type}-${c.contactID ?? c.id}`,
    source: "rentvine",
    sourceUrl: "https://aloepm.rentvine.com",
    defaultFields: {
      firstName: c.firstName ?? "",
      lastName:  c.lastName  ?? "",
      role,
      ...(company       && { company }),
      ...(c.email       && { emails:       [{ name: "Email", value: c.email }] }),
      ...(c.phone       && { phoneNumbers: [{ name: "Phone", value: c.phone }] }),
    }
  };
}

// ─── UPSERT LOGIC ────────────────────────────────────────────────────────────

async function upsert(contact, type) {
  const payload = buildPayload(contact, type);

  // 1. Try to find by externalId first (already synced before)
  let existing = await findByExternalId(payload.externalId);
  let matchedBy = "externalId";

  // 2. If not found by externalId, search by phone number
  if (!existing && contact.phone) {
    existing = await findByPhone(contact.phone);
    matchedBy = "phone";
  }

  if (existing) {
    // Merge: update existing contact with latest Rentvine data
    // Also stamp the externalId so future syncs use fast path
    await updateContact(existing.id, payload);
    return { action: "updated", matchedBy };
  }

  // 3. Not found anywhere — create new
  await createContact(payload);
  return { action: "created", matchedBy: "none" };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Rentvine → Quo sync starting");
  console.log(`   Types: ${TYPES.join(", ")}`);

  const summary = { created: 0, updated: 0, mergedByPhone: 0, failed: 0 };

  for (const type of TYPES) {
    let contacts;
    try {
      contacts = await fetchAll(type);
    } catch (e) {
      console.error(`❌ Fetch ${type} failed: ${e.message}`);
      continue;
    }

    console.log(`\n📤 Upserting ${contacts.length} ${type}...`);

    for (let i = 0; i < contacts.length; i++) {
      try {
        const { action, matchedBy } = await upsert(contacts[i], type);
        summary[action]++;
        if (matchedBy === "phone") summary.mergedByPhone++;

        if ((i + 1) % 50 === 0 || i === contacts.length - 1) {
          console.log(`  [${i + 1}/${contacts.length}] ✅ ${action} (by ${matchedBy})`);
        }
      } catch (e) {
        summary.failed++;
        const id = contacts[i].contactID ?? contacts[i].id ?? "?";
        console.error(`  ❌ rentvine-${type}-${id}: ${e.message}`);
      }
      await sleep(150);
    }
  }

  console.log("\n─────────────────────────────────────");
  console.log("✅ Sync complete");
  console.log(`   Created       : ${summary.created}`);
  console.log(`   Updated       : ${summary.updated}`);
  console.log(`   Merged/phone  : ${summary.mergedByPhone}`);
  console.log(`   Failed        : ${summary.failed}`);
  console.log("─────────────────────────────────────");
  process.exit(0);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
