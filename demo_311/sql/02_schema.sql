-- The documents table — verbatim from the tutorial
create table documents
( id                  uuid          not null primary key default uuidv7()
                                    check (uuid_extract_version(id) = 7)
, content             text          not null                              -- the chunk text
, meta                jsonb         not null default '{}'                 -- arbitrary attrs
, tree                ltree         not null default ''::ltree            -- hierarchical path
, temporal            tstzrange                                           -- optional time range
, geom                geometry(Point, 4326)                               -- optional WGS84 point
, embedding           halfvec(1536)                                       -- nullable until embedded
, embedding_version   int           not null default 1                    -- bumps on content change
, embedding_attempts  int           not null default 0
, embedding_last_error text
, created_at          timestamptz   not null default now()
, updated_at          timestamptz
);

-- meta must be an object, not a scalar or array
alter table documents add check (jsonb_typeof(meta) = 'object');

-- temporal convention: point-in-time is [t,t] inclusive, ranges are [start,end)
alter table documents add constraint temporal_bounds_convention check (
    temporal is null
    or (lower(temporal) = upper(temporal) and lower_inc(temporal) and upper_inc(temporal))
    or (lower(temporal) <  upper(temporal) and lower_inc(temporal) and not upper_inc(temporal))
);
