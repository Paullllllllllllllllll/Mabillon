import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
	CLASSIFICATIONS_V1,
	CM_DECISIONS_V2,
	CM_TABLES_V1,
	CM_TRIGGERS_V3,
	CORE_V1,
	CORE_V2,
	CT_PAGE_TYPES_V2,
	CT_VIEWS_V1,
} from "./ddl.ts";
import { pyJsonDumps } from "./py.ts";
import { Connection, type Param, type Row } from "./sqlite.ts";

/**
 * The run stores of ChronoTranscriber (`chronotranscriber.sqlite`) and ChronoMiner (`chronominer.sqlite`) as
 * Mabillon writes them: the same tables and views at the same schema versions, rows written with the semantics of
 * their `common/store.py` (document ids above every dropped one, unit counts and status refreshed in the
 * transaction that changes the units, leases with a holder, generation and expiry, rendered files recorded with
 * their hash). Mabillon refuses a store at any other version and creates a missing one with their exact DDL.
 */

export type StoreTool = "chronotranscriber" | "chronominer";

export const DATABASE_NAMES: Record<StoreTool, string> = {
	chronotranscriber: "chronotranscriber.sqlite",
	chronominer: "chronominer.sqlite",
};

/** The component versions of ChronoTranscriber v1.3.1 and ChronoMiner v1.4.1, in their migration order. */
export const COMPONENT_VERSIONS: Record<StoreTool, Array<[string, number]>> = {
	chronotranscriber: [
		["core", 2],
		["chronotranscriber", 3],
		["classifications", 1],
	],
	chronominer: [
		["core", 2],
		["classifications", 1],
		["chronominer", 3],
	],
};

const DROPPED_MARK = "dropped_doc_id";
export const LEASE_TTL = 600;
export const HEARTBEAT_INTERVAL = 60;
export const BLOCKING_SUBMISSIONS = ["submitting", "submitted", "unresolved"];
const BLOCKING_SQL = BLOCKING_SUBMISSIONS.map((status) => `'${status}'`).join(", ");

export class StoreError extends Error {}
export class LeaseLostError extends Error {}

/** `datetime.fromtimestamp(t, tz=UTC).isoformat(timespec="milliseconds")`. */
export function isoTime(seconds: number = Date.now() / 1000): string {
	return new Date(Math.floor(seconds * 1000)).toISOString().replace(/Z$/, "+00:00");
}

export function nowSeconds(): number {
	return Date.now() / 1000;
}

export function fileSha256(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const hash = createHash("sha256");
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(1 << 20);
		for (let read = readSync(fd, buffer, 0, buffer.length, null); read > 0; ) {
			hash.update(buffer.subarray(0, read));
			read = readSync(fd, buffer, 0, buffer.length, null);
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

export function textSha256(text: string | Buffer): string {
	return createHash("sha256").update(text).digest("hex");
}

/** The tool's JSON columns as `json.dumps(value, ensure_ascii=False)` writes them. */
export function jsonColumn(value: unknown): string | null {
	return value === undefined || value === null ? null : pyJsonDumps(value);
}

// ---------------------------------------------------------------------------------------------------------------
// Schema

function tableNames(connection: Connection): string[] {
	return connection
		.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
		.map((row) => String(row.name));
}

function quote(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

const ENTRY_COLUMNS = ["document", "chunk_index", "entry_index", "schema", "model", "provider", "run_id"];

function fieldAlias(name: string): string {
	const fixed = new Set(ENTRY_COLUMNS.map((column) => column.toLowerCase()));
	return fixed.has(name.toLowerCase()) ? `field_${name}` : name;
}

/** ChronoMiner's `create_entries_view`: the `entries` view over the current `f_` columns of `entry_rows`. */
export function createEntriesView(connection: Connection): void {
	const columns = connection
		.all("PRAGMA table_info(entry_rows)")
		.map((row) => String(row.name))
		.filter((name) => name.startsWith("f_"));
	const fields = columns
		.map((column) => `    e.${quote(column)} AS ${quote(fieldAlias(column.slice(2)))},\n`)
		.join("");
	connection.exec("DROP VIEW IF EXISTS entries");
	connection.exec(
		"CREATE VIEW entries AS\nSELECT\n" +
			"    d.name AS document,\n" +
			"    e.idx + 1 AS chunk_index,\n" +
			"    e.entry_index AS entry_index,\n" +
			"    e.schema_name AS schema,\n" +
			`${fields}` +
			"    e.model AS model,\n" +
			"    e.provider AS provider,\n" +
			"    e.run_id AS run_id\n" +
			"FROM entry_rows AS e\n" +
			"JOIN documents AS d ON d.doc_id = e.doc_id\n" +
			"JOIN units AS u ON u.doc_id = e.doc_id AND u.kind = e.kind AND u.idx = e.idx\n" +
			"WHERE u.status = 'done' AND u.stale = 0 AND u.run_id = e.run_id\n" +
			"ORDER BY d.name, e.idx, e.entry_index",
	);
}

/** Run each `;`-separated statement of a script, as ChronoMiner's version 1 and 2 steps do. */
function runStatements(connection: Connection, script: string): void {
	for (const statement of script.split(";")) if (statement.trim()) connection.exec(statement);
}

const STEPS: Record<string, Array<(connection: Connection) => void>> = {
	core: [(c) => c.exec(CORE_V1), (c) => c.exec(CORE_V2)],
	chronotranscriber: [(c) => c.exec(CT_VIEWS_V1), (c) => c.exec(CT_PAGE_TYPES_V2), () => undefined],
	classifications: [(c) => c.exec(CLASSIFICATIONS_V1)],
	chronominer: [
		(c) => {
			runStatements(c, CM_TABLES_V1);
			createEntriesView(c);
		},
		(c) => runStatements(c, CM_DECISIONS_V2),
		(c) => c.exec(CM_TRIGGERS_V3),
	],
};

/** Create every table, view and trigger of a fresh store and its `meta` rows, in the tool's migration order. */
function createSchema(connection: Connection, tool: StoreTool): void {
	for (const [component, version] of COMPONENT_VERSIONS[tool]) {
		for (const step of STEPS[component].slice(0, version)) step(connection);
		connection.run(
			"INSERT INTO meta (component, version) VALUES (?, ?) ON CONFLICT (component) DO UPDATE SET version = excluded.version",
			component,
			version,
		);
	}
}

function toolLabel(tool: StoreTool): string {
	return tool === "chronotranscriber" ? "ChronoTranscriber" : "ChronoMiner";
}

/** Refuse a store whose tables have no `meta`, or whose components are not exactly the pinned versions. */
function checkSchema(connection: Connection, tool: StoreTool, path: string): "empty" | "ok" {
	const tables = tableNames(connection);
	if (tables.length === 0) return "empty";
	if (!tables.includes("meta")) {
		throw new StoreError(
			`${path} holds tables but no schema version: it is not a ${tool} store and is left as it is.`,
		);
	}
	const found = new Map(
		connection.all("SELECT component, version FROM meta").map((row) => [String(row.component), Number(row.version)]),
	);
	found.delete(DROPPED_MARK);
	const expected = new Map(COMPONENT_VERSIONS[tool]);
	const describe = (versions: Map<string, number>) =>
		[...versions].map(([component, version]) => `${component} ${version}`).join(", ") || "none";
	const same =
		found.size === expected.size && [...expected].every(([component, version]) => found.get(component) === version);
	if (!same) {
		throw new StoreError(
			`${path} carries schema versions ${describe(found)}; Mabillon writes only the store of ${toolLabel(tool)} ${tool === "chronotranscriber" ? "v1.3.1" : "v1.4.1"} (${describe(expected)}). Open it with that ${toolLabel(tool)} version, or use another output folder. The store is left as it is.`,
		);
	}
	return "ok";
}

// ---------------------------------------------------------------------------------------------------------------
// Rows

export interface DocumentRow {
	doc_id: number;
	name: string;
	tool: string;
	input_path: string | null;
	input_sha256: string | null;
	kind: string | null;
	status: string;
	units_total: number;
	units_pending: number;
	units_done: number;
	units_failed: number;
	lease_run_id: string | null;
	lease_until: number | null;
	lease_generation: number;
}

export interface UnitRow {
	doc_id: number;
	kind: string;
	idx: number;
	status: string;
	outcome: string | null;
	source_index: number | string | null;
	label: string | null;
	content: string | null;
	tool: string;
	model: string;
	provider: string;
	run_id: string;
	attempts: number;
	usage: string | null;
	error: string | null;
	error_type: string | null;
	provenance: string | null;
	stale: number;
	updated_at: string | null;
}

export interface PlannedUnit {
	idx: number;
	label: string | null;
	sourceIndex: number | string | null;
}

/** One unit as Mabillon writes it (status done or failed). */
export interface UnitWrite {
	kind: string;
	idx: number;
	status: "done" | "failed";
	outcome: string;
	content: string | null;
	label: string | null;
	sourceIndex: number | string | null;
	model: string;
	provider: string;
	usage?: Record<string, unknown> | null;
	error?: string | null;
	errorType?: string | null;
	provenance?: Record<string, unknown> | null;
	attempts?: number;
}

export interface Lease {
	docId: number;
	holder: string;
	generation: number;
	until: number;
}

/** A unit row's identity for the check that nobody changed it between Mabillon's read and its write. */
export function unitSignature(row: Pick<UnitRow, "status" | "run_id" | "updated_at" | "tool">): string {
	return `${row.status}|${row.tool}|${row.run_id}|${row.updated_at ?? ""}`;
}

const NEXT_DOC_ID = `(SELECT max(
    COALESCE((SELECT max(doc_id) FROM documents), 0),
    COALESCE((SELECT version FROM meta WHERE component = '${DROPPED_MARK}'), 0)
) + 1)`;

const REFRESH_COUNTS = `UPDATE documents SET
    units_total = (SELECT count(*) FROM units AS u WHERE u.doc_id = documents.doc_id),
    units_pending = (SELECT count(*) FROM units AS u WHERE u.doc_id = documents.doc_id AND u.status = 'pending'),
    units_done = (SELECT count(*) FROM units AS u WHERE u.doc_id = documents.doc_id AND u.status = 'done'),
    units_failed = (SELECT count(*) FROM units AS u WHERE u.doc_id = documents.doc_id AND u.status = 'failed')
WHERE doc_id = ?`;

const REFRESH_STATUS = `UPDATE documents SET status = CASE
    WHEN units_total = 0 OR units_pending = units_total THEN 'pending'
    WHEN units_done = units_total THEN 'complete'
    WHEN units_pending = 0 THEN 'failed'
    ELSE 'partial'
END WHERE doc_id = ?`;

const UPSERT_UNIT = `INSERT INTO units (
    doc_id, kind, idx, status, outcome, source_index, label, content, tool,
    model, provider, run_id, attempts, usage, error, error_type, provenance,
    response_id, stale, updated_at
) VALUES (
    :doc_id, :kind, :idx, :status, :outcome, :source_index, :label, :content,
    :tool, :model, :provider, :run_id, COALESCE(:attempts, 1), :usage, :error,
    :error_type, :provenance, NULL, 0, :now
)
ON CONFLICT (doc_id, kind, idx) DO UPDATE SET
    status = excluded.status,
    outcome = excluded.outcome,
    source_index = COALESCE(excluded.source_index, units.source_index),
    label = COALESCE(excluded.label, units.label),
    content = excluded.content,
    tool = excluded.tool,
    model = excluded.model,
    provider = excluded.provider,
    run_id = excluded.run_id,
    attempts = COALESCE(:attempts, units.attempts + 1),
    usage = excluded.usage,
    error = excluded.error,
    error_type = excluded.error_type,
    provenance = excluded.provenance,
    response_id = excluded.response_id,
    stale = 0,
    updated_at = excluded.updated_at`;

const PLAN_UNIT = `INSERT INTO units (
    doc_id, kind, idx, status, source_index, label, tool, model, provider,
    run_id, attempts, stale, updated_at
) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, 0, ?)
ON CONFLICT (doc_id, kind, idx) DO NOTHING`;

const REPLAN_UNIT = `INSERT INTO units (
    doc_id, kind, idx, status, source_index, label, tool, model, provider,
    run_id, attempts, stale, updated_at
) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, 0, ?)
ON CONFLICT (doc_id, kind, idx) DO UPDATE SET
    status = 'pending', outcome = NULL, content = NULL, usage = NULL,
    error = NULL, error_type = NULL, provenance = NULL, response_id = NULL,
    attempts = 0, stale = 0, source_index = excluded.source_index,
    label = excluded.label, run_id = excluded.run_id,
    updated_at = excluded.updated_at`;

const OUTPUT_DONE = `INSERT INTO outputs (doc_id, path, format, sha256, rendered_at, run_id, stale)
VALUES (?, ?, ?, ?, ?, ?, 0)
ON CONFLICT (doc_id, path) DO UPDATE SET
    format = excluded.format, sha256 = excluded.sha256,
    rendered_at = excluded.rendered_at, run_id = excluded.run_id, stale = 0`;

const OUTPUT_STALE = `INSERT INTO outputs (doc_id, path, format, sha256, rendered_at, run_id, stale)
VALUES (?, ?, ?, ?, NULL, ?, 1)
ON CONFLICT (doc_id, path) DO UPDATE SET format = excluded.format, stale = 1`;

/** `bounded_error`: error text cut to 2,000 characters, marked when cut. */
export function boundedError(text: string | null | undefined): string | null {
	if (text === null || text === undefined) return null;
	const chars = [...text];
	if (chars.length <= 2000) return text;
	return `${chars.slice(0, 2000).join("")} [... ${(chars.length - 2000).toLocaleString("en-US")} more characters]`;
}

// ---------------------------------------------------------------------------------------------------------------
// Rendered files

export interface RenderTarget {
	path: string;
	format: string;
	text: string;
}

export interface RenderReport {
	written: string[];
	unchanged: string[];
	kept: string[];
	stale: string[];
	warnings: string[];
}

export function emptyReport(): RenderReport {
	return { written: [], unchanged: [], kept: [], stale: [], warnings: [] };
}

/**
 * Write rendered files with the guard of the tools' render driver: a file whose hash is neither the recorded one
 * nor the new rendering was changed outside the tools and is kept unless `force`; a file that cannot be read or
 * replaced is reported stale. `record` receives each file that now holds the rendering (or failed) with its hash.
 */
export function writeGuarded(
	targets: RenderTarget[],
	recorded: (path: string) => string | undefined,
	force: boolean,
	record: (target: RenderTarget, sha256: string | undefined, ok: boolean) => void,
	report: RenderReport = emptyReport(),
): RenderReport {
	for (const target of targets) {
		const data = Buffer.from(target.text, "utf8");
		const sha = textSha256(data);
		let current: string | undefined;
		try {
			current = fileSha256(target.path);
		} catch (error) {
			report.stale.push(target.path);
			report.warnings.push(
				`${target.path} could not be read (${(error as Error).message}); the data is stored and the output is marked stale.`,
			);
			record(target, recorded(target.path), false);
			continue;
		}
		const known = recorded(target.path);
		if (current !== undefined && current !== known && current !== sha && !force) {
			report.kept.push(target.path);
			report.warnings.push(
				`${target.path} was changed outside the tool and is left as it is; run again with --force to replace it.`,
			);
			continue;
		}
		if (current === sha) {
			report.unchanged.push(target.path);
			record(target, sha, true);
			continue;
		}
		const temp = join(
			dirname(target.path),
			`.${basename(target.path)}.${randomUUID().replace(/-/g, "").slice(0, 8)}.tmp`,
		);
		try {
			mkdirSync(dirname(target.path), { recursive: true });
			writeFileSync(temp, data);
			renameSync(temp, target.path);
		} catch (error) {
			try {
				rmSync(temp, { force: true });
			} catch {
				// left behind
			}
			report.stale.push(target.path);
			report.warnings.push(
				`${target.path} could not be replaced (${(error as Error).message}); the data is stored and the output is marked stale.`,
			);
			record(target, known ?? current, false);
			continue;
		}
		report.written.push(target.path);
		record(target, sha, true);
	}
	return report;
}

// ---------------------------------------------------------------------------------------------------------------
// The store

export interface RunInfo {
	command: string;
	toolVersion: string;
	spec: Record<string, { value: unknown; source: string }>;
}

const openStores = new Set<ChronoStore>();
let exitHook = false;

function installExitHook(): void {
	if (exitHook) return;
	exitHook = true;
	// A process that exits without closing its stores (a second Ctrl+C) gives its leases up on the way out.
	process.on("exit", () => {
		for (const store of openStores) store.releaseAllQuietly();
	});
}

export class ChronoStore {
	readonly root: string;
	readonly tool: StoreTool;
	readonly path: string;
	readonly connection: Connection;
	private runId: string | undefined;
	private readonly info: RunInfo;
	private readonly held = new Map<number, Lease>();
	private timer: NodeJS.Timeout | undefined;
	/** Leases the heartbeat could not renew; writes on these documents are refused. */
	readonly lost = new Set<number>();

	private constructor(root: string, tool: StoreTool, info: RunInfo, connection: Connection) {
		this.root = root;
		this.tool = tool;
		this.path = join(root, DATABASE_NAMES[tool]);
		this.info = info;
		this.connection = connection;
	}

	/** Open the store of `root`, creating it with the tool's DDL when it is missing or empty; refuse other versions. */
	static open(root: string, tool: StoreTool, info: RunInfo): ChronoStore {
		mkdirSync(root, { recursive: true });
		const path = join(root, DATABASE_NAMES[tool]);
		const connection = new Connection(path);
		try {
			connection.transaction((c) => {
				if (checkSchema(c, tool, path) === "empty") createSchema(c, tool);
			});
		} catch (error) {
			connection.close();
			throw error;
		}
		const store = new ChronoStore(root, tool, info, connection);
		openStores.add(store);
		installExitHook();
		return store;
	}

	/** Check a store without writing: undefined when there is none, else whether Mabillon accepts its versions. */
	static inspect(root: string, tool: StoreTool): void {
		const path = join(root, DATABASE_NAMES[tool]);
		if (!existsSync(path)) return;
		const connection = new Connection(path, { readOnly: true });
		try {
			checkSchema(connection, tool, path);
		} finally {
			connection.close();
		}
	}

	/** The id of this invocation's run in the store; the `runs` row is written on first use. */
	run(): string {
		if (this.runId) return this.runId;
		const runId = randomUUID();
		this.connection.transaction((c) =>
			c.run(
				"INSERT INTO runs (run_id, tool, tool_version, command, started_at, spec, settings_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)",
				runId,
				"mabillon",
				this.info.toolVersion,
				this.info.command,
				isoTime(),
				jsonColumn(this.info.spec),
				null,
			),
		);
		this.runId = runId;
		return runId;
	}

	storeArtifact(kind: string, text: string): string {
		const digest = textSha256(text);
		const runId = this.run();
		this.connection.transaction((c) =>
			c.run(
				"INSERT INTO artifacts (sha256, kind, text, run_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (sha256) DO NOTHING",
				digest,
				kind,
				text,
				runId,
				isoTime(),
			),
		);
		return digest;
	}

	document(name: string): DocumentRow | undefined {
		return this.connection.get("SELECT * FROM documents WHERE name = ?", name) as DocumentRow | undefined;
	}

	documentById(docId: number): DocumentRow | undefined {
		return this.connection.get("SELECT * FROM documents WHERE doc_id = ?", docId) as DocumentRow | undefined;
	}

	units(docId: number, kind?: string): UnitRow[] {
		return (kind === undefined
			? this.connection.all("SELECT * FROM units WHERE doc_id = ? ORDER BY kind, idx", docId)
			: this.connection.all(
					"SELECT * FROM units WHERE doc_id = ? AND kind = ? ORDER BY idx",
					docId,
					kind,
				)) as unknown as UnitRow[];
	}

	/** Units held by a submission that is still submitting, submitted or unresolved. */
	blockedUnits(docId: number, connection: Connection = this.connection): Array<{ kind: string; idx: number }> {
		return connection.all(
			`SELECT DISTINCT r.kind, r.idx FROM submission_requests AS r JOIN submissions AS s ON s.submission_id = r.submission_id WHERE r.doc_id = ? AND s.status IN (${BLOCKING_SQL}) ORDER BY r.kind, r.idx`,
			docId,
		) as Array<{ kind: string; idx: number }>;
	}

	runTool(runId: string): string | undefined {
		const row = this.connection.get("SELECT tool FROM runs WHERE run_id = ?", runId);
		return row ? String(row.tool) : undefined;
	}

	/** The id of document `name`, creating its row when missing; an existing row is changed only under its lease. */
	ensureDocument(name: string, inputPath: string, kind: string): number {
		const runId = this.run();
		return this.connection.transaction((c) => {
			c.run(
				`INSERT INTO documents (doc_id, name, tool, input_path, input_sha256, kind, first_run_id, last_run_id, updated_at) VALUES (${NEXT_DOC_ID}, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING`,
				name,
				"mabillon",
				inputPath,
				null,
				kind,
				runId,
				runId,
				isoTime(),
			);
			return Number((c.get("SELECT doc_id FROM documents WHERE name = ?", name) as Row).doc_id);
		});
	}

	/**
	 * Lease a document (free, expired or this run's own). Returns undefined while another run holds an unexpired
	 * lease, whichever tool that run belongs to.
	 */
	acquire(docId: number): Lease | undefined {
		const holder = this.run();
		const lease = this.connection.transaction((c) => {
			const now = nowSeconds();
			const until = now + LEASE_TTL;
			const changes = c.run(
				"UPDATE documents SET lease_run_id = ?, lease_until = ?, lease_generation = lease_generation + 1 WHERE doc_id = ? AND (lease_run_id IS NULL OR lease_until IS NULL OR lease_until <= ? OR lease_run_id = ?)",
				holder,
				until,
				docId,
				now,
				holder,
			).changes;
			if (changes === 0) return undefined;
			const generation = Number(
				(c.get("SELECT lease_generation FROM documents WHERE doc_id = ?", docId) as Row).lease_generation,
			);
			return { docId, holder, generation, until };
		});
		if (lease) {
			this.held.set(docId, lease);
			this.lost.delete(docId);
			this.startHeartbeat();
		}
		return lease;
	}

	/** Raise unless `lease` still holds at the clock reading inside the transaction. */
	checkLease(connection: Connection, lease: Lease): void {
		if (this.lost.has(lease.docId)) throw new LeaseLostError(`The lease on document ${lease.docId} expired.`);
		const row = connection.get(
			"SELECT lease_run_id, lease_generation, lease_until FROM documents WHERE doc_id = ?",
			lease.docId,
		);
		if (!row) throw new LeaseLostError(`Document ${lease.docId} does not exist.`);
		if (row.lease_run_id !== lease.holder || Number(row.lease_generation) !== lease.generation) {
			throw new LeaseLostError(`The lease on document ${lease.docId} passed to another holder.`);
		}
		if (row.lease_until === null || Number(row.lease_until) <= nowSeconds()) {
			throw new LeaseLostError(`The lease on document ${lease.docId} expired.`);
		}
	}

	private renew(lease: Lease): void {
		const changes = this.connection.transaction((c) => {
			const now = nowSeconds();
			return c.run(
				"UPDATE documents SET lease_until = ? WHERE doc_id = ? AND lease_run_id = ? AND lease_generation = ? AND lease_until > ?",
				now + LEASE_TTL,
				lease.docId,
				lease.holder,
				lease.generation,
				now,
			).changes;
		});
		if (changes === 0) {
			this.held.delete(lease.docId);
			this.lost.add(lease.docId);
		} else {
			lease.until = nowSeconds() + LEASE_TTL;
		}
	}

	private startHeartbeat(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			for (const lease of [...this.held.values()]) {
				try {
					this.renew(lease);
				} catch {
					// a busy or unreadable database: the next beat tries again
				}
			}
		}, HEARTBEAT_INTERVAL * 1000);
		this.timer.unref();
	}

	release(lease: Lease): void {
		this.held.delete(lease.docId);
		this.connection.transaction((c) =>
			c.run(
				"UPDATE documents SET lease_run_id = NULL, lease_until = NULL WHERE doc_id = ? AND lease_run_id = ? AND lease_generation = ?",
				lease.docId,
				lease.holder,
				lease.generation,
			),
		);
	}

	/** Give every lease of this run up (on exit); errors are ignored. */
	releaseAllQuietly(): void {
		if (!this.runId || !this.connection.db.isOpen) return;
		try {
			this.connection.run(
				"UPDATE documents SET lease_run_id = NULL, lease_until = NULL WHERE lease_run_id = ?",
				this.runId,
			);
		} catch {
			// nothing more to do while exiting
		}
	}

	/** Run `work` in one transaction that first checks `lease`. */
	leased<T>(lease: Lease, work: (connection: Connection) => T): T {
		return this.connection.transaction((c) => {
			this.checkLease(c, lease);
			return work(c);
		});
	}

	/** Record the end of this invocation's run and close the store, releasing its leases. */
	close(exitCode: number | undefined): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		try {
			for (const lease of [...this.held.values()]) {
				try {
					this.release(lease);
				} catch {
					// released on exit
				}
			}
			if (this.runId && exitCode !== undefined) {
				const runId = this.runId;
				this.connection.transaction((c) =>
					c.run("UPDATE runs SET ended_at = ?, exit_code = ? WHERE run_id = ?", isoTime(), exitCode, runId),
				);
			}
			this.releaseAllQuietly();
		} finally {
			openStores.delete(this);
			this.connection.close();
		}
	}

	/** An output path as the outputs registry keys it: relative to the database folder (posix), else absolute. */
	pathKey(path: string): string {
		const rel = relative(this.root, path);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
		return path;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Unit writes inside a leased transaction

export function refreshDocument(connection: Connection, docId: number, runId: string | null): void {
	connection.run(REFRESH_COUNTS, docId);
	connection.run(REFRESH_STATUS, docId);
	connection.run(
		"UPDATE documents SET last_run_id = COALESCE(?, last_run_id), updated_at = ? WHERE doc_id = ?",
		runId,
		isoTime(),
		docId,
	);
}

export function markOutputsStale(connection: Connection, docId: number): void {
	connection.run("UPDATE outputs SET stale = 1 WHERE doc_id = ? AND stale = 0", docId);
}

/** `plan_units`: create the expected units as pending, keeping existing rows; returns the number created. */
export function planUnits(
	connection: Connection,
	docId: number,
	kind: string,
	units: PlannedUnit[],
	stamp: { runId: string; model: string; provider: string },
): number {
	const now = isoTime();
	let created = 0;
	for (const unit of units) {
		created += connection.run(
			PLAN_UNIT,
			docId,
			kind,
			unit.idx,
			unit.sourceIndex,
			unit.label,
			"mabillon",
			stamp.model,
			stamp.provider,
			stamp.runId,
			now,
		).changes;
	}
	if (created > 0) markOutputsStale(connection, docId);
	refreshDocument(connection, docId, stamp.runId);
	return created;
}

/** `write_unit`: upsert one unit; the document's rendered files are marked stale and its counts refreshed. */
export function writeUnit(connection: Connection, docId: number, unit: UnitWrite, runId: string): void {
	const params: Record<string, Param> = {
		doc_id: docId,
		kind: unit.kind,
		idx: unit.idx,
		status: unit.status,
		outcome: unit.outcome,
		source_index: unit.sourceIndex,
		label: unit.label,
		content: unit.content,
		tool: "mabillon",
		model: unit.model,
		provider: unit.provider,
		run_id: runId,
		attempts: unit.attempts ?? 1,
		usage: jsonColumn(unit.usage),
		error: boundedError(unit.error),
		error_type: unit.errorType ?? null,
		provenance: jsonColumn(unit.provenance),
		now: isoTime(),
	};
	connection.runNamed(UPSERT_UNIT, params);
	markOutputsStale(connection, docId);
	refreshDocument(connection, docId, runId);
}

export function recordIdentity(connection: Connection, docId: number, sha256: string): void {
	connection.run("UPDATE documents SET input_sha256 = ? WHERE doc_id = ?", sha256, docId);
}

/** Record a rendered file: done with its hash, or stale keeping the recorded hash. */
export function recordOutput(
	connection: Connection,
	docId: number,
	key: string,
	format: string,
	sha256: string | undefined,
	ok: boolean,
	runId: string,
): void {
	if (ok) connection.run(OUTPUT_DONE, docId, key, format, sha256 ?? null, isoTime(), runId);
	else connection.run(OUTPUT_STALE, docId, key, format, sha256 ?? null, runId);
}

export function recordedOutputs(connection: Connection, docId: number): Map<string, string | undefined> {
	return new Map(
		connection
			.all("SELECT path, sha256 FROM outputs WHERE doc_id = ?", docId)
			.map((row) => [String(row.path), row.sha256 === null ? undefined : String(row.sha256)]),
	);
}

function refuseBlocking(connection: Connection, docId: number): void {
	const held = connection
		.all(
			`SELECT DISTINCT r.submission_id FROM submission_requests AS r JOIN submissions AS s ON s.submission_id = r.submission_id WHERE s.status IN (${BLOCKING_SQL}) AND r.doc_id = ? ORDER BY r.submission_id`,
			docId,
		)
		.map((row) => String(row.submission_id));
	if (held.length > 0) {
		throw new StoreError(
			`Submission ${held.join(", ")} still holds units of document ${docId}; run batch check, or abandon it, first.`,
		);
	}
}

/**
 * ChronoTranscriber's `forced_replacement` (``--force``): delete the units the new plan does not hold, return the
 * planned ones to pending, delete the page types, mark the outputs stale and record the input identity.
 */
export function ctForcedReplacement(
	connection: Connection,
	docId: number,
	kind: string,
	units: PlannedUnit[],
	stamp: { runId: string; model: string; provider: string },
	inputSha256: string,
): void {
	refuseBlocking(connection, docId);
	const idxs = JSON.stringify(units.map((unit) => unit.idx));
	const replaced = "doc_id = ? AND (kind != ? OR idx NOT IN (SELECT value FROM json_each(?)))";
	connection.run(`DELETE FROM submission_requests WHERE ${replaced}`, docId, kind, idxs);
	connection.run(`DELETE FROM units WHERE ${replaced}`, docId, kind, idxs);
	const now = isoTime();
	for (const unit of units) {
		connection.run(
			REPLAN_UNIT,
			docId,
			kind,
			unit.idx,
			unit.sourceIndex,
			unit.label,
			"mabillon",
			stamp.model,
			stamp.provider,
			stamp.runId,
			now,
		);
	}
	connection.run("DELETE FROM page_types WHERE doc_id = ?", docId);
	connection.run("UPDATE outputs SET stale = 1 WHERE doc_id = ?", docId);
	recordIdentity(connection, docId, inputSha256);
	refreshDocument(connection, docId, stamp.runId);
}

/**
 * ChronoMiner's chunk replacement: `_drop_chunks` (entries, relevance rows, settled batch requests and the chunk
 * units; the store's triggers flag the classification answers stale) followed by planning the new chunks.
 */
export function cmReplaceChunks(
	connection: Connection,
	docId: number,
	units: PlannedUnit[],
	stamp: { runId: string; model: string; provider: string },
): void {
	refuseBlocking(connection, docId);
	connection.run("DELETE FROM entry_rows WHERE doc_id = ? AND kind = 'chunk'", docId);
	connection.run("DELETE FROM chunk_decisions WHERE doc_id = ?", docId);
	connection.run(
		`DELETE FROM submission_requests WHERE doc_id = ? AND kind = 'chunk' AND submission_id NOT IN (SELECT submission_id FROM submissions WHERE status IN (${BLOCKING_SQL}))`,
		docId,
	);
	connection.run("DELETE FROM units WHERE doc_id = ? AND kind = 'chunk'", docId);
	refreshDocument(connection, docId, stamp.runId);
	planUnits(connection, docId, "chunk", units, stamp);
}

/** ChronoMiner under ``--force`` with an unchanged layout: every chunk back to pending, relevance rows cleared. */
export function cmResetChunks(connection: Connection, docId: number, runId: string): void {
	refuseBlocking(connection, docId);
	const count = connection.run(
		"UPDATE units SET status = 'pending', outcome = NULL, content = NULL, usage = NULL, error = NULL, error_type = NULL, provenance = NULL, response_id = NULL, attempts = 0, stale = 0, run_id = ?, updated_at = ? WHERE doc_id = ? AND kind = 'chunk'",
		runId,
		isoTime(),
		docId,
	).changes;
	if (count > 0) markOutputsStale(connection, docId);
	connection.run("DELETE FROM chunk_decisions WHERE doc_id = ?", docId);
	refreshDocument(connection, docId, runId);
}

export { refuseBlocking };

/** True when `path` is a file the size check considers present and non-empty. */
export function nonEmptyFile(path: string): boolean {
	try {
		return statSync(path).size > 0;
	} catch {
		return false;
	}
}
