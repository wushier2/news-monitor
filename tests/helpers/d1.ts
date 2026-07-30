import { DatabaseSync, type SQLInputValue } from "node:sqlite";

function d1Meta(changes = 0, lastRowId = 0): D1Meta & Record<string, unknown> {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    changes,
  };
}

class TestStatement {
  private values: SQLInputValue[] = [];

  constructor(private readonly statement: ReturnType<DatabaseSync["prepare"]>) {}

  bind(...values: unknown[]): TestStatement {
    this.values = values as SQLInputValue[];
    return this;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      results: this.statement.all(...this.values) as T[],
      success: true,
      meta: d1Meta(),
    };
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async run<T>(): Promise<D1Result<T>> {
    const result = this.statement.run(...this.values);
    const changes = Number(result.changes);
    return {
      results: [],
      success: true,
      meta: d1Meta(changes, Number(result.lastInsertRowid)),
    };
  }
}

export function createTestD1() {
  const sqlite = new DatabaseSync(":memory:");
  const db = {
    prepare(sql: string) {
      return new TestStatement(sqlite.prepare(sql));
    },
    async batch(statements: TestStatement[]) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database;
  return { db, sqlite };
}
