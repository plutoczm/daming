export interface LuluRunRecord {
  readonly runId: string;
  readonly status: 'completed';
  readonly evidence: unknown;
  readonly completedAt: string;
}

export interface LuluRunStore {
  get(runId: string): LuluRunRecord | undefined;
  save(record: LuluRunRecord): void;
}

export class MemoryLuluRunStore implements LuluRunStore {
  private readonly records = new Map<string, LuluRunRecord>();

  get(runId: string): LuluRunRecord | undefined {
    return this.records.get(runId);
  }

  save(record: LuluRunRecord): void {
    this.records.set(record.runId, record);
  }
}
