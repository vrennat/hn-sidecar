/**
 * Resumability for the seed crawl: "resumable, checkpointed".
 *
 * The checkpoint is a keyset cursor, not an offset, so it stays correct even
 * though the corpus grows underneath a long crawl. NDJSON is appended, never
 * rewritten, so an interrupted run leaves a valid prefix rather than a corrupt
 * file — and a resumed run continues from the last committed cursor.
 */

export interface Checkpoint {
  /** Highest story id already written to the output file. */
  readonly cursor: number;
  /** Rows written so far, for progress reporting only. */
  readonly written: number;
  /** Which backend produced this file; mixing them mid-file is a bug. */
  readonly source: 'clickhouse' | 'firebase';
  readonly updated_at: number;
}

export const readCheckpoint = async (path: string): Promise<Checkpoint | null> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as Checkpoint;
  } catch {
    return null;
  }
};

export const writeCheckpoint = async (path: string, checkpoint: Checkpoint): Promise<void> => {
  await Bun.write(path, JSON.stringify(checkpoint));
};

/**
 * Guards the one resume mistake that silently corrupts a seed: continuing a file
 * that a different backend started, or resuming past a cursor the output file
 * does not actually reach.
 */
export const assertResumable = (
  checkpoint: Checkpoint,
  source: Checkpoint['source'],
  outputLines: number,
): void => {
  if (checkpoint.source !== source) {
    throw new Error(
      `checkpoint was written by "${checkpoint.source}" but this run is "${source}"; ` +
        'delete the output and checkpoint to start over rather than mixing sources',
    );
  }
  if (outputLines < checkpoint.written) {
    throw new Error(
      `checkpoint claims ${checkpoint.written} rows written but the output has ${outputLines}; ` +
        'the output was truncated — delete both and start over',
    );
  }
};
