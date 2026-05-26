// Binary COPY encoder for halfvec(D) writeback batches.
//
// Wire formats are from the Postgres docs and pgvector source:
//   - PG binary COPY header: "PGCOPY\n\xff\r\n\0" + int32 flags + int32 hdrExt
//   - Per-tuple: int16 nFields, then for each field: int32 length + bytes (-1 = NULL)
//   - PG binary trailer: int16 -1
//
//   - bigint (int8)  : 8 bytes, big-endian (Node has no int64 setter — we split)
//   - uuid           : 16 raw bytes (the textual hyphens are stripped)
//   - int (int4)     : 4 bytes, big-endian
//   - halfvec(D)     : int16 dim, int16 unused=0, then D * (float16 big-endian)

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`bad uuid: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface BatchRow {
  queueId: bigint;       // int8
  docId: string;         // uuid
  version: number;       // int4
  embedding: number[];   // float32[] from the embedding model
}

/**
 * Encode a batch as PG binary COPY bytes for a temp table with columns:
 *   (q_id bigint, doc_id uuid, ver int, vec halfvec(D))
 */
export function encodeBatchBinaryCopy(rows: BatchRow[], dim: number): Buffer {
  // 1. Compute total size for one allocation.
  const headerSize = 11 + 4 + 4;       // "PGCOPY\n\xff\r\n\0" + flags + hdrExt
  const tupleHeader = 2;               // int16 nFields
  const bigintField = 4 + 8;
  const uuidField   = 4 + 16;
  const intField    = 4 + 4;
  const halfvecBody = 2 + 2 + dim * 2; // dim, unused, D float16s
  const halfvecField = 4 + halfvecBody;
  const perTuple = tupleHeader + bigintField + uuidField + intField + halfvecField;
  const trailer = 2;
  const total = headerSize + perTuple * rows.length + trailer;

  const buf = Buffer.allocUnsafe(total);
  let off = 0;

  // Header: "PGCOPY\n\xff\r\n\0"
  buf.write('PGCOPY\n\xff\r\n\0', off, 'binary');
  off += 11;
  buf.writeInt32BE(0, off); off += 4;  // flags
  buf.writeInt32BE(0, off); off += 4;  // header extension length

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  for (const r of rows) {
    if (r.embedding.length !== dim) {
      throw new Error(`embedding length ${r.embedding.length} != ${dim}`);
    }
    // int16 nFields
    buf.writeInt16BE(4, off); off += 2;

    // q_id (bigint, 8 bytes, big-endian)
    buf.writeInt32BE(8, off); off += 4;
    buf.writeBigInt64BE(r.queueId, off); off += 8;

    // doc_id (uuid, 16 bytes)
    buf.writeInt32BE(16, off); off += 4;
    const uuidBytes = uuidToBytes(r.docId);
    buf.set(uuidBytes, off); off += 16;

    // version (int, 4 bytes)
    buf.writeInt32BE(4, off); off += 4;
    buf.writeInt32BE(r.version, off); off += 4;

    // halfvec field
    buf.writeInt32BE(halfvecBody, off); off += 4;
    buf.writeInt16BE(dim, off); off += 2;
    buf.writeInt16BE(0, off); off += 2;
    for (let i = 0; i < dim; i++) {
      view.setFloat16(off, r.embedding[i], false); // big-endian
      off += 2;
    }
  }

  // Trailer
  buf.writeInt16BE(-1, off); off += 2;

  if (off !== total) throw new Error(`encoder size mismatch: wrote ${off}, expected ${total}`);
  return buf;
}
