-- Core RAG table: supports 7 search modes (semantic, full-text, hierarchical, geo, temporal, metadata).
-- Drop columns you don't use; keep the structure. Drop constraints for unused columns too.

CREATE TABLE IF NOT EXISTS documents (
  id                  uuid          NOT NULL PRIMARY KEY DEFAULT uuidv7()
                                    CHECK (uuid_extract_version(id) = 7),
  content             text          NOT NULL,
  meta                jsonb         NOT NULL DEFAULT '{}',
  tree                ltree         NOT NULL DEFAULT ''::ltree,
  temporal            tstzrange,
  geom                geometry(Point, 4326),
  embedding           halfvec(1536),
  embedding_version   int           NOT NULL DEFAULT 1,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz
);

-- meta must be a JSON object (not array/scalar)
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_meta_is_object;
ALTER TABLE documents ADD CONSTRAINT documents_meta_is_object
  CHECK (jsonb_typeof(meta) = 'object');

-- temporal must be NULL or follow range conventions: [t,t] (point) or [start,end) (bounded)
ALTER TABLE documents DROP CONSTRAINT IF EXISTS temporal_bounds_convention;
ALTER TABLE documents ADD CONSTRAINT temporal_bounds_convention CHECK (
  temporal IS NULL
  OR (
    NOT isempty(temporal)
    AND (
      (lower(temporal) = upper(temporal) AND lower_inc(temporal) AND upper_inc(temporal))
      OR (lower(temporal) < upper(temporal) AND lower_inc(temporal) AND NOT upper_inc(temporal))
    )
  )
);
