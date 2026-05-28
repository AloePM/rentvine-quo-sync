/**
 * index.js — Rentvine → Quo Contact Sync
 *
 * Runs as a Google Cloud Run Job triggered by Cloud Scheduler.
 * Credentials are injected as environment variables via Secret Manager.
 */

import fetch from "node-fetch";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const RENTVINE_BASE  = "https://aloepm.rentvine.com/api/manager";
const RENTVINE_AUTH  = "Basic " + Buffer.from(
  `${process.env.RENTVINE_KEY}:${process.env.RENTVINE_SECRET}`
).toString("base64");
const QUO_API_KEY    = process.env.QUO_API_KEY;
const QUO_BASE       = "https://api.openphone.com/v1";
const CONTACT_TYPES  = ["owners", "tenants", "vendors", "associations"];
const PAGE_SIZE      = 250;
const QUO_DELAY_MS   = 150; // avoid rate limiting

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAllContacts(type) {
  const all = [];
  let page = 1;

  console.log(`\n📥 Fetching ${type}...`);

  while (true) {
    const url = `${RENTVINE_BASE}/${type}?page=${page}&pageSize=${PAGE_SIZE}`;
    const res = await fetch(url, {
      headers: { Authorization: RENTVINE_AUTH, Accept: "application/json" },
    });

    if (!res.ok) throw new Error(`Rentvine ${type} page ${page}: ${res.status}`);

    const json = await res.json();
    const records = Array.isArray(json) ? json : (json.data ?? []);
    const contacts = records.map((item) => item.contact ?? item);

    all.push(...contacts);
    console.log(`  Page ${page}: ${contacts.length} records (total: ${all.length})`);

    if (contacts.length < PAGE_SIZE) break;
    page++;
  }

  return all;
}

function buildPayload(contact, type) {
  const role    = type.charAt(0).toUpperCase() + type.slice(1, -1);
  const company = contact.taxPayerName && contact.taxPayerName !== contact.name
    ? contact.taxPayerName : "";

  return {
    externalId: `rentvine-${type}-${contact.contactID}`,
    source: "rentvine",
    sourceUrl: "https://aloepm.rentvine.com",
    defaultFields: {
      firstName: contact.firstName ?? "",
      lastName:  contact.lastName  ?? "",
      role,
      ...(company       && { company }),
      ...(contact.email && { emails:       [{ value: contact.email }] }),
      ...(contact.phone && { phoneNumbers: [{ value: contact.phone }] }),
    },
  };
}

async function upsert(payload) {
  // Look up by externalId
  const findRes = await fetch(
    `${QUO_BASE}/contacts?externalId=${encodeURIComponent(payload.externalId)}`,
    { headers: { Authorization: `Bearer ${QUO_API_KEY}` } }
  );
  if (!findRes.ok) throw new Error(`Quo lookup: ${findRes.status}`);
  const existing = ((await findRes.json()).data ?? [])[0];

  if (existing) {
    const res = await fetch(`${QUO_BASE}/contacts/${existing.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${QUO_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Quo update: ${res.status} – ${await res.text()}`);
    return "updated";
  } else {
    const res = await fetch(`${QUO_BASE}/contacts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${QUO_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Quo create: ${res.status} – ${await res.text()}`);
    return "created";
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Rentvine → Quo contact sync starting");
  console.log(`   Types: ${CONTACT_TYPES.join(", ")}`);

  const summary = { created: 0, updated: 0, failed: 0 };

  for (const type of CONTACT_TYPES) {
    let contacts;
    try {
      contacts = await fetchAllContacts(type);
    } catch (err) {
      console.error(`❌ Fetch ${type} failed: ${err.message}`);
      continue;
    }

    console.log(`\n📤 Upserting ${contacts.length} ${type} into Quo...`);

    for (let i = 0; i < contacts.length; i++) {
      const payload = buildPayload(contacts[i], type);
      try {
        const action = await upsert(payload);
        summary[action]++;
        if ((i + 1) % 50 === 0 || i === contacts.length - 1) {
          console.log(`  [${i + 1}/${contacts.length}] ✅ ${action} – ${payload.externalId}`);
        }
      } catch (err) {
        summary.failed++;
        console.error(`  ❌ ${payload.externalId}: ${err.message}`);
      }
      await sleep(QUO_DELAY_MS);
    }
  }

  console.log("\n─────────────────────────────────");
  console.log("✅ Sync complete");
  console.log(`   Created : ${summary.created}`);
  console.log(`   Updated : ${summary.updated}`);
  console.log(`   Failed  : ${summary.failed}`);
  console.log("─────────────────────────────────");

  // Exit cleanly — Cloud Run Jobs look for exit code 0
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
