-- The documents table: one row per 311 service request.
-- `content` is the denormalized retrieval blob (descriptor + address + resolution).
-- `meta` holds structured filters (agency, status, complaint_type, borough, ...).
-- `tree` is `nyc.<borough>.<agency>.<complaint_type>`.
-- `temporal` is `[created_date, closed_date)` for closed tickets, `[created_date, 'infinity')` for open ones (still active).
-- `geom` is the incident location in WGS84.
create table documents
( id                  uuid          not null primary key default uuidv7()
                                    check (uuid_extract_version(id) = 7)
, content             text          not null
, meta                jsonb         not null default '{}'
, tree                ltree         not null default ''::ltree
, temporal            tstzrange
, geom                geometry(Point, 4326)
, embedding           halfvec(1536)
, embedding_version   int           not null default 1
, created_at          timestamptz   not null default now()
, updated_at          timestamptz
);

alter table documents add check (jsonb_typeof(meta) = 'object');

alter table documents add constraint temporal_bounds_convention check (
    temporal is null
    or (lower(temporal) = upper(temporal) and lower_inc(temporal) and upper_inc(temporal))
    or (lower(temporal) <  upper(temporal) and lower_inc(temporal) and not upper_inc(temporal))
);
