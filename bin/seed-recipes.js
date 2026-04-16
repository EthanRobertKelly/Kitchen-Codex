#!/usr/bin/env node
// Reads XML recipe files and merges them into Firestore via REST API.
// Usage: node bin/seed-recipes.js recipe-imports/char-siu.xml recipe-imports/steamed-bbq-pork-buns.xml

const fs   = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_ID = 'ek-kitchencodex-6301d';
const API_KEY    = 'AIzaSyCCCgLA1g50-qA3ThHVtCzMcZBmttXV0bc';
const BASE_URL   = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/kitchen`;

// ── helpers ──────────────────────────────────────────────────────────────────

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search,
      method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Parse a Firestore string field value
function fsStr(v) { return v?.stringValue ?? null; }

// Encode a plain JS object as a Firestore document fields map
function toFsFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) { fields[k] = { nullValue: null }; continue; }
    if (typeof v === 'string')  { fields[k] = { stringValue: v }; continue; }
    if (typeof v === 'number')  { fields[k] = { integerValue: String(v) }; continue; }
    if (typeof v === 'boolean') { fields[k] = { booleanValue: v }; continue; }
  }
  return fields;
}

// ── XML parser (no deps) ──────────────────────────────────────────────────────

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1].replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
}

function innerText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim().replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
}

function parseXML(xml) {
  const recipeMatch = xml.match(/<Recipe([^>]*)>/);
  if (!recipeMatch) throw new Error('No <Recipe> tag found');
  const recipeTag = recipeMatch[1];

  const metaMatch = xml.match(/<Meta([^>]*)\/?>/);
  const meta = metaMatch ? metaMatch[1] : '';

  const ingredients = [...xml.matchAll(/<Ingredient([^>]*)\/?>/g)].map(m => ({
    amount: attr(m[1], 'amount'),
    unit:   attr(m[1], 'unit'),
    name:   attr(m[1], 'name'),
  }));

  const steps = [...xml.matchAll(/<Step[^>]*>([^<]*)<\/Step>/g)].map(m =>
    m[1].trim().replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  );

  return {
    id:         attr(recipeTag, 'id'),
    name:       attr(recipeTag, 'name'),
    tag:        attr(recipeTag, 'tag'),
    emoji:      attr(recipeTag, 'emoji'),
    favorite:   attr(recipeTag, 'favorite') === 'true',
    created:    parseInt(attr(recipeTag, 'created')) || Date.now(),
    prep:       attr(meta, 'prep'),
    cook:       attr(meta, 'cook'),
    ttc:        parseInt(attr(meta, 'ttc')) || 0,
    servings:   attr(meta, 'servings'),
    difficulty: attr(meta, 'difficulty'),
    notes:      innerText(xml, 'Notes'),
    ingredients,
    steps,
    reviews:    [],
    photo:      null,
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('Usage: node bin/seed-recipes.js <file.xml> ...'); process.exit(1); }

  const newRecipes = files.map(f => {
    const xml = fs.readFileSync(path.resolve(f), 'utf8');
    const r = parseXML(xml);
    console.log(`Parsed: ${r.name} (${r.id})`);
    return r;
  });

  // Fetch current recipes doc
  console.log('\nFetching current recipes from Firestore…');
  const getRes = await request('GET', `${BASE_URL}/recipes?key=${API_KEY}`, null);
  if (getRes.status !== 200 && getRes.status !== 404) {
    console.error('Firestore GET failed:', getRes.status, JSON.stringify(getRes.body, null, 2));
    process.exit(1);
  }

  let existing = [];
  if (getRes.status === 200 && getRes.body.fields?.value?.stringValue) {
    existing = JSON.parse(getRes.body.fields.value.stringValue);
    console.log(`Found ${existing.length} existing recipe(s).`);
  } else {
    console.log('No existing recipes found, starting fresh.');
  }

  // Merge: skip if id already present
  let added = 0;
  for (const r of newRecipes) {
    if (existing.find(e => e.id === r.id)) {
      console.log(`  Skipping "${r.name}" — already exists.`);
    } else {
      existing.unshift(r);
      added++;
      console.log(`  Adding "${r.name}"`);
    }
  }

  if (!added) { console.log('\nNothing new to add.'); return; }

  // Strip photos (they go in kitchen/photos doc; new recipes have none anyway)
  const photos = {};
  const clean = existing.map(r => {
    if (r.photo) photos[r.id] = r.photo;
    const { photo, ...rest } = r;
    return rest;
  });

  // Write recipes doc
  const payload = { fields: { value: { stringValue: JSON.stringify(clean) } } };
  console.log('\nWriting recipes to Firestore…');
  const patchRes = await request('PATCH', `${BASE_URL}/recipes?key=${API_KEY}`, payload);
  if (patchRes.status !== 200) {
    console.error('Firestore PATCH failed:', patchRes.status, JSON.stringify(patchRes.body, null, 2));
    process.exit(1);
  }

  // Write photos doc (preserve existing)
  if (Object.keys(photos).length) {
    const getPhotosRes = await request('GET', `${BASE_URL}/photos?key=${API_KEY}`, null);
    const existingPhotos = getPhotosRes.status === 200
      ? Object.fromEntries(Object.entries(getPhotosRes.body.fields || {}).map(([k,v]) => [k, fsStr(v)]).filter(([,v]) => v))
      : {};
    const mergedPhotos = { ...existingPhotos, ...photos };
    const photoFields = {};
    for (const [k, v] of Object.entries(mergedPhotos)) photoFields[k] = { stringValue: v };
    await request('PATCH', `${BASE_URL}/photos?key=${API_KEY}`, { fields: photoFields });
  }

  console.log(`\nDone — ${added} recipe(s) added.`);
}

main().catch(e => { console.error(e); process.exit(1); });
