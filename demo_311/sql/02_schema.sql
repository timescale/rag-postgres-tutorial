-- Step 1: documents table
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
