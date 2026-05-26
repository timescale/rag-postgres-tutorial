# Tutorial review notes — `blog_rag_tutorial.md`

Walking through the tutorial end-to-end against the NYC 311 dataset on Ghost, 2 000 rows. Everything that follows is what tripped up the implementation (or *would have*, for a less forgiving reader).

## SQL

All the SQL in Steps 1–4 applied unchanged against PG 18 + pgvector + ltree + postgis + pg_textsearch. No corrections needed. The schema, indexes, triggers, `claim_embedding_batch`, and `prune_embedding_queue` work as written.

Verified end-to-end behavior:
- `documents_before_update_trg` nulls `embedding` and bumps `embedding_version` on content change.
- Both enqueue triggers fire on insert and on content-changing update.
- Two rapid edits → `claim_embedding_batch` cancels the v2 job (superseded) and processes v3. Confirmed with `embedding_queue` rows showing `outcome = 'cancelled'` for v2 and `'completed'` for v3.

## TypeScript snippets

All the TS code in the tutorial typechecks against `postgres@3.4.9` + `zod@3.25` + `ai@6` + `@ai-sdk/openai@3` + `@modelcontextprotocol/sdk@1` with `tsc --strict`. I had initially flagged `postgres.Fragment`, `postgres.JSONValue`, and `z.record(key, value)` as compile errors — those are wrong; all three are exported / supported on the versions in `package.json`.

## Worker runtime gotchas (not bugs, but undocumented)

- **First batch is ~5–10× slower than steady state.** Observed: first batch `write=8113ms`, subsequent `write=500–1500ms`. Likely TLS handshake / connection warmup. The tutorial cites "50–80 ms RTT" but Ghost from my location is ~240 ms RTT minimum. With one worker, my throughput was 27 emb/s steady (vs. roughly 33–40/s the tutorial's RTT implies).
- **`BATCH_SIZE=64` was a good default**, matching the tutorial's "32–128 sweet spot."

## Documentation / gap nits

- **The "chunking" guidance for 311 is implicit.** Step 1's box says "we assume content is already chunked," and Step 7's description-hints suggest "the descriptor, the resolution, the address, all concatenated." A reader has to make this call. For my loader I went with `complaint_type + descriptor + location_type + address + agency_name + status + resolution_description`, joined by newlines. That made BM25 work well on `pothole`, `rat`, `noise` queries and semantic work well on paraphrases.
- **Bulk-load pattern under-described.** Step 1's box recommends `COPY ... FROM STDIN`; the worker section mentions `unnest`. Neither shows a complete bulk-insert example using `unnest` with all six columns (content, meta, tree, temporal, geom). `demo_311/src/load.ts` is that example.

## Performance notes

End-to-end on Ghost, 2 000 rows, single worker, my laptop → Ghost (~240ms RTT):

| Step | Time |
|---|---|
| Load 2 000 rows (one `INSERT … unnest` per 1 000-row page) | 11.3 s |
| Build BM25 + HNSW (post-load) | 3.9 s |
| Embed 2 000 docs, BATCH_SIZE=64, `text-embedding-3-small` | 73.3 s (27.3/s) |
|   of which: OpenAI `embedMany` | 25.6 s (35%) |
|   of which: DB roundtrip (claim + writeback) | 47.0 s (64%) |

Verdict: the worker is **not too slow**. DB roundtrip dominates at ~240ms RTT × 2 (claim + writeback) × 31 batches ≈ ~15s of pure RTT; the remainder (~32s) is server-side claim/writeback work. Larger `BATCH_SIZE` (128) would amortize more, especially with `text-embedding-3-small`'s 8192-input limit; we still have headroom.

## What did *not* break

- All seven search modes (BM25, semantic, hybrid RRF, ltree, temporal, geo radius, JSONB containment) returned sensible results on first run.
- The composed-filters query at the end of `search-cli.ts` (hybrid + ltree + temporal + geo + meta) returned 5 hits in 1.9 s on a 2 000-row corpus, all in Brooklyn, all noise-related, all within 5 km of City Hall.
- The version-race scenario (two edits before the worker drained) produced exactly the cancel/complete pattern the tutorial promised.
