import { createRequire } from "node:module";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

/**
 * Connections to the ChronoTranscriber and ChronoMiner stores through Node's built-in `node:sqlite`, configured as
 * their writers configure theirs: rollback journal (`journal_mode=DELETE`), `synchronous=FULL`, foreign keys on and
 * a busy timeout. Writes run inside `BEGIN IMMEDIATE ... COMMIT`; a busy database is retried with backoff.
 */

const require = createRequire(import.meta.url);
let sqliteModule: typeof import("node:sqlite") | undefined;

/** Load node:sqlite once, without its ExperimentalWarning (it would reach stderr on every run). */
function sqlite(): typeof import("node:sqlite") {
	if (sqliteModule) return sqliteModule;
	const original = process.emitWarning;
	process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
		const text = typeof warning === "string" ? warning : warning?.message;
		if (typeof text === "string" && text.includes("SQLite is an experimental feature")) return;
		(original as (...args: unknown[]) => void).call(process, warning, ...rest);
	}) as typeof process.emitWarning;
	try {
		sqliteModule = require("node:sqlite") as typeof import("node:sqlite");
	} finally {
		process.emitWarning = original;
	}
	return sqliteModule;
}

export const BUSY_TIMEOUT_MS = 30_000;
const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 2000;

export type Row = Record<string, unknown>;
/** A number bound as REAL even when it is integral (a Python float such as `1.0`). */
export class Real {
	readonly value: number;

	constructor(value: number) {
		this.value = value;
	}
}

export type Param = SQLInputValue | boolean | undefined | Real;

/**
 * A parameter as Python's sqlite3 binds it: integers as INTEGER (a JS number would bind as REAL, which changes
 * `typeof` in untyped columns and the text of TEXT columns), booleans as 0 or 1, undefined as NULL.
 */
export function bind(value: Param): SQLInputValue {
	if (value === undefined) return null;
	if (value instanceof Real) return value.value;
	if (typeof value === "boolean") return value ? 1n : 0n;
	if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
	return value;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusy(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const code = (error as { errcode?: number }).errcode;
	return code === 5 || code === 6 || /database is (locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

export class Connection {
	readonly path: string;
	readonly db: DatabaseSync;
	private readonly cache = new Map<string, StatementSync>();

	constructor(path: string, options: { readOnly?: boolean } = {}) {
		this.path = path;
		const { DatabaseSync } = sqlite();
		this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false, enableForeignKeyConstraints: true });
		this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		if (!options.readOnly) {
			const mode = this.get("PRAGMA journal_mode = DELETE");
			const value = String(mode ? Object.values(mode)[0] : "").toLowerCase();
			if (value !== "delete") {
				this.db.close();
				throw new Error(`${path}: the journal mode stays ${value}; close other connections to the file`);
			}
		}
		this.db.exec("PRAGMA synchronous = FULL");
		this.db.exec("PRAGMA foreign_keys = ON");
	}

	private statement(sql: string): StatementSync {
		let statement = this.cache.get(sql);
		if (!statement) {
			statement = this.db.prepare(sql);
			this.cache.set(sql, statement);
		}
		return statement;
	}

	run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
		const result = this.statement(sql).run(...params.map(bind));
		return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
	}

	/** Run a statement with named parameters (`:name`), bound like positional ones. */
	runNamed(sql: string, params: Record<string, Param>): { changes: number } {
		const bound = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, bind(value)]));
		return { changes: Number(this.statement(sql).run(bound).changes) };
	}

	get(sql: string, ...params: Param[]): Row | undefined {
		return this.statement(sql).get(...params.map(bind)) as Row | undefined;
	}

	all(sql: string, ...params: Param[]): Row[] {
		return this.statement(sql).all(...params.map(bind)) as Row[];
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	/**
	 * Run `work` inside one `BEGIN IMMEDIATE ... COMMIT`. A busy database (another writer holds the lock beyond the
	 * busy timeout) rolls back and retries with backoff; any other error rolls back and propagates.
	 */
	transaction<T>(work: (connection: Connection) => T): T {
		let delay = RETRY_MIN_MS;
		for (;;) {
			try {
				this.db.exec("BEGIN IMMEDIATE");
			} catch (error) {
				if (!isBusy(error)) throw error;
				sleepSync(delay);
				delay = Math.min(delay * 2, RETRY_MAX_MS);
				continue;
			}
			let result: T;
			try {
				result = work(this);
			} catch (error) {
				this.rollback();
				if (!isBusy(error)) throw error;
				sleepSync(delay);
				delay = Math.min(delay * 2, RETRY_MAX_MS);
				continue;
			}
			for (;;) {
				try {
					this.db.exec("COMMIT");
					return result;
				} catch (error) {
					if (!isBusy(error)) {
						this.rollback();
						throw error;
					}
					sleepSync(delay);
					delay = Math.min(delay * 2, RETRY_MAX_MS);
				}
			}
		}
	}

	private rollback(): void {
		try {
			this.db.exec("ROLLBACK");
		} catch {
			// no transaction open
		}
	}

	close(): void {
		this.cache.clear();
		if (this.db.isOpen) this.db.close();
	}
}

/** Run `queries` on a short read-only connection. */
export function readOnly<T>(path: string, queries: (connection: Connection) => T): T {
	const connection = new Connection(path, { readOnly: true });
	try {
		return queries(connection);
	} finally {
		connection.close();
	}
}
