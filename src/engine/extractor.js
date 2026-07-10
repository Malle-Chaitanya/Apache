import { repo } from '../db/repository.js';
import { MATRIX, EXTRACT_ORDER } from '../mapping/matrix.js';
import { contentHash } from '../lib/hash.js';

// EXTRACT: pull every object from the source into staging (one collection per
// type). Idempotent: re-extracting the same object updates in place.
export async function extract(ctx) {
  const { project, source, emit } = ctx;
  const counts = {};
  for (const type of EXTRACT_ORDER) {
    const meta = MATRIX[type];
    const rows = await source.list(type);
    for (const raw of rows) {
      // Ticket conversations are a sub-resource; pull them into the staged doc.
      if (type === 'tickets') raw.comments = await source.listComments(raw);
      const sourceId = String(raw.id);
      await repo(type).upsert(
        { projectId: project._id, sourceId },
        { projectId: project._id, domain: meta.domain, entityType: type, sourceId,
          sourceRaw: raw, contentHash: contentHash(raw), status: 'extracted' },
      );
    }
    counts[type] = rows.length;
    emit('extract', type, `extracted ${rows.length} ${type}`);
  }
  return counts;
}
