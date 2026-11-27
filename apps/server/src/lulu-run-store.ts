import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LuluRunRecord, LuluRunStore } from '@daming/connectors-lulu';

interface StoreFile {
  readonly version: 1;
  readonly records: Record<string, LuluRunRecord>;
}

function load(file: string): Record<string, LuluRunRecord> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || (parsed as StoreFile).version !== 1) throw new Error('invalid_version');
    const records = (parsed as StoreFile).records;
    if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('invalid_records');
    return records;
  } catch {
    throw new Error('Invalid Lulu evidence store: ' + file);
  }
}

/** Durable evidence snapshots; not a task scheduler and not a second task ledger. */
export class FileLuluRunStore implements LuluRunStore {
  private readonly file: string;
  private records: Record<string, LuluRunRecord>;

  constructor(file: string) {
    this.file = file;
    this.records = load(file);
  }

  get(runId: string): LuluRunRecord | undefined {
    return this.records[runId];
  }

  save(record: LuluRunRecord): void {
    this.records = { ...this.records, [record.runId]: record };
    mkdirSync(dirname(this.file), { recursive: true });
    const data: StoreFile = { version: 1, records: this.records };
    writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`);
  }
}
