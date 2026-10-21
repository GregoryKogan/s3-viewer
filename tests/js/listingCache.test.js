import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./loadTs.mjs";

const { ListingCache, estimateListingBytes, listingCacheKey } = await loadTs(
  "src/lib/listingCache.ts",
);

/** The shape the store stores; only `entries` matters for sizing. */
function entry(key, extra = {}) {
  return { key, name: key, isFolder: false, size: 0, kind: "other", ...extra };
}

function listing(key, extra = {}) {
  return {
    entries: [entry(key)],
    truncated: false,
    warning: null,
    fetchedAt: 1_700_000_000_000,
    ...extra,
  };
}

/** Every one-character key costs the same, which makes the budget arithmetic readable. */
const ONE_ENTRY_BYTES = estimateListingBytes([entry("a")]);

test("a stored listing round-trips and is accounted for in bytes", () => {
  const cache = new ListingCache(() => ONE_ENTRY_BYTES * 4);
  const entries = [entry("a"), entry("b/c.txt")];
  const stored = {
    entries,
    truncated: true,
    warning: "the listing was partial",
    fetchedAt: 1_700_000_001_234,
  };

  assert.equal(cache.set("k", stored), true);

  const hit = cache.get("k");
  assert.equal(hit.entries, entries);
  assert.equal(hit.truncated, true);
  assert.equal(hit.warning, "the listing was partial");
  assert.equal(hit.fetchedAt, 1_700_000_001_234);
  assert.equal(cache.bytes, estimateListingBytes(entries));
  assert.equal(cache.size, 1);
});

test("a missing key is null and delete frees the entry's bytes", () => {
  const cache = new ListingCache(() => ONE_ENTRY_BYTES * 4);

  assert.equal(cache.get("missing"), null);

  cache.set("k", listing("a"));
  assert.equal(cache.bytes, ONE_ENTRY_BYTES);
  assert.equal(cache.size, 1);

  cache.delete("k");
  assert.equal(cache.get("k"), null);
  assert.equal(cache.bytes, 0);
  assert.equal(cache.size, 0);

  // A missing key is a no-op, not an error.
  cache.delete("missing");
  assert.equal(cache.bytes, 0);
});

test("a get bumps recency so the untouched entry is evicted", () => {
  const cache = new ListingCache(() => ONE_ENTRY_BYTES * 2);
  cache.set("a", listing("a"));
  cache.set("b", listing("b"));

  // Touch the older entry, then add a third: the untouched one is the victim.
  assert.notEqual(cache.get("a"), null);
  assert.equal(cache.set("c", listing("c")), true);

  assert.notEqual(cache.get("a"), null);
  assert.equal(cache.get("b"), null);
  assert.notEqual(cache.get("c"), null);
  assert.equal(cache.size, 2);
  assert.equal(cache.bytes, ONE_ENTRY_BYTES * 2);
});

test("an entry larger than the whole budget is refused and evicts nothing", () => {
  const limit = ONE_ENTRY_BYTES * 2;
  const cache = new ListingCache(() => limit);
  const huge = listing("x".repeat(limit));

  assert.equal(cache.set("huge", huge), false);
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
  assert.equal(cache.get("huge"), null);

  cache.set("a", listing("a"));
  cache.set("b", listing("b"));
  assert.equal(cache.set("huge", huge), false);
  assert.notEqual(cache.get("a"), null);
  assert.notEqual(cache.get("b"), null);
  assert.equal(cache.size, 2);
});

test("trim evicts down to a lowered limit", () => {
  let limit = ONE_ENTRY_BYTES * 3;
  const cache = new ListingCache(() => limit);
  cache.set("a", listing("a"));
  cache.set("b", listing("b"));
  cache.set("c", listing("c"));
  assert.equal(cache.size, 3);

  limit = ONE_ENTRY_BYTES;
  cache.trim();

  assert.equal(cache.bytes <= limit, true);
  assert.equal(cache.size, 1);
  assert.equal(cache.get("a"), null);
  assert.equal(cache.get("b"), null);
  // The most recently used entry survives the eviction.
  assert.notEqual(cache.get("c"), null);
});

test("a zero limit disables reads and writes and lets trim clear", () => {
  let limit = ONE_ENTRY_BYTES * 2;
  const cache = new ListingCache(() => limit);
  cache.set("a", listing("a"));
  assert.equal(cache.size, 1);

  limit = 0;
  assert.equal(cache.get("a"), null);
  assert.equal(cache.set("b", listing("b")), false);
  cache.trim();
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
});

test("listingCacheKey separates connections and the estimate grows with text", () => {
  const prefix = "folder/";
  assert.notEqual(listingCacheKey("conn-a", prefix), listingCacheKey("conn-b", prefix));
  // Same connection and prefix is the same entry; the encoding is the frozen one.
  assert.equal(listingCacheKey("conn-a", prefix), listingCacheKey("conn-a", prefix));
  assert.equal(listingCacheKey("conn-a", prefix), JSON.stringify(["conn-a", prefix]));

  const short = estimateListingBytes([entry("a")]);
  assert.equal(estimateListingBytes([entry("a-longer-key")]) > short, true);
  // Missing optional fields count as zero rather than throwing.
  const emptyOptionals = entry("a", { lastModified: null, etag: null, storageClass: null });
  assert.equal(estimateListingBytes([emptyOptionals]), short);
  const withTimestamp = entry("a", { lastModified: "2026-10-21T12:00:00Z" });
  assert.equal(estimateListingBytes([withTimestamp]) > short, true);
});

test("the limit getter is read per operation, never in the constructor", () => {
  let calls = 0;
  let limit = 0;
  const cache = new ListingCache(() => {
    calls += 1;
    return limit;
  });

  assert.equal(calls, 0);
  assert.equal(cache.set("a", listing("a")), false);

  // Raising the limit applies to the existing cache without recreating it.
  const callsBeforeRaise = calls;
  limit = ONE_ENTRY_BYTES * 2;
  assert.equal(cache.set("a", listing("a")), true);
  assert.equal(cache.size, 1);
  assert.equal(calls > callsBeforeRaise, true);
});

test("a non-finite limit is treated as zero", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const cache = new ListingCache(() => bad);
    assert.equal(cache.set("a", listing("a")), false);
    assert.equal(cache.get("a"), null);
    assert.equal(cache.size, 0);
  }
});

test("set replaces the previous listing before the size check", () => {
  const limit = ONE_ENTRY_BYTES * 2;
  const cache = new ListingCache(() => limit);
  cache.set("k", listing("a"));

  // A fitting replacement updates the accounted bytes, not just the listing.
  const longer = listing("a-longer");
  assert.equal(cache.set("k", longer), true);
  assert.equal(cache.size, 1);
  assert.equal(cache.bytes, estimateListingBytes(longer.entries));

  // A replacement too large to keep still removes the old entry.
  const oversized = { ...listing("b"), entries: [entry("b"), entry("c"), entry("d")] };
  assert.equal(cache.set("k", oversized), false);
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
});
