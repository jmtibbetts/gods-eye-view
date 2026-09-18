import { createConflictReportsLayer } from '../../layers/conflictReports/index.js';
import * as context from '../../data/contextStore.js';

/** Wire the conflict-reporting layer to the shared context store. */
export function createApplicationConflictReports({ source }) {
  return createConflictReportsLayer({ source, context });
}
