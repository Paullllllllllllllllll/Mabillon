/**
 * The store schema of ChronoTranscriber v1.3.1 and ChronoMiner v1.4.1, copied verbatim from their migration steps
 * (`common/store.py`, `common/classify_store.py`, `output/store.py`). Mabillon creates a fresh store by running
 * the same steps in the same order and refuses a store at any other version.
 */

/** `common/store.py` _CORE_V1. */
export const CORE_V1 = `
CREATE TABLE meta (
    component TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 1)
);
CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    tool TEXT NOT NULL,
    tool_version TEXT,
    command TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    exit_code INTEGER,
    spec TEXT,
    settings_fingerprint TEXT
);
CREATE TABLE artifacts (
    sha256 TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    run_id TEXT REFERENCES runs (run_id),
    created_at TEXT NOT NULL
);
CREATE TABLE documents (
    doc_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    tool TEXT NOT NULL,
    input_path TEXT,
    input_sha256 TEXT,
    kind TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'partial', 'complete', 'failed')),
    units_total INTEGER NOT NULL DEFAULT 0,
    units_pending INTEGER NOT NULL DEFAULT 0,
    units_done INTEGER NOT NULL DEFAULT 0,
    units_failed INTEGER NOT NULL DEFAULT 0,
    image_settings TEXT,
    first_run_id TEXT REFERENCES runs (run_id),
    last_run_id TEXT REFERENCES runs (run_id),
    lease_run_id TEXT,
    lease_until REAL,
    lease_generation INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
);
CREATE TABLE units (
    doc_id INTEGER NOT NULL REFERENCES documents (doc_id),
    kind TEXT NOT NULL,
    idx INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'done', 'failed')),
    outcome TEXT,
    source_index,
    label TEXT,
    content TEXT,
    tool TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs (run_id),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    usage TEXT,
    error TEXT,
    error_type TEXT,
    provenance TEXT,
    response_id INTEGER REFERENCES responses (response_id),
    stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
    updated_at TEXT,
    PRIMARY KEY (doc_id, kind, idx)
);
CREATE INDEX units_by_status ON units (doc_id, status);
CREATE TABLE responses (
    response_id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER REFERENCES documents (doc_id),
    kind TEXT,
    idx INTEGER,
    run_id TEXT NOT NULL REFERENCES runs (run_id),
    tool TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    role TEXT,
    attempt INTEGER,
    submission_id TEXT REFERENCES submissions (submission_id),
    custom_id TEXT,
    request TEXT,
    raw BLOB,
    raw_kind TEXT CHECK (raw_kind IS NULL OR raw_kind IN ('http', 'sdk', 'line')),
    usage TEXT,
    error TEXT,
    error_type TEXT,
    http_status INTEGER,
    latency REAL,
    created_at TEXT NOT NULL,
    CHECK (raw IS NULL OR raw_kind IS NOT NULL)
);
CREATE INDEX responses_by_unit ON responses (doc_id, kind, idx);
CREATE TRIGGER responses_no_update BEFORE UPDATE ON responses
BEGIN
    SELECT RAISE (ABORT, 'responses are append-only');
END;
CREATE TRIGGER responses_no_delete BEFORE DELETE ON responses
BEGIN
    SELECT RAISE (ABORT, 'responses are append-only');
END;
CREATE TABLE submissions (
    submission_id TEXT PRIMARY KEY,
    tool TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs (run_id),
    part INTEGER NOT NULL DEFAULT 0,
    intent_at TEXT NOT NULL,
    upload_ref TEXT,
    batch_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('submitting', 'submitted', 'unresolved', 'failed', 'finalized', 'abandoned', 'cancelled')),
    provider_status TEXT,
    request_count INTEGER NOT NULL DEFAULT 0,
    counts TEXT,
    last_checked_at TEXT,
    finalized_at TEXT,
    error TEXT,
    updated_at TEXT,
    CHECK (status NOT IN ('submitted', 'finalized') OR batch_id IS NOT NULL)
);
CREATE INDEX submissions_by_status ON submissions (status);
CREATE UNIQUE INDEX submissions_by_batch ON submissions (provider, batch_id)
    WHERE batch_id IS NOT NULL;
CREATE TABLE submission_requests (
    submission_id TEXT NOT NULL REFERENCES submissions (submission_id),
    custom_id TEXT NOT NULL,
    doc_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    idx INTEGER NOT NULL,
    PRIMARY KEY (submission_id, custom_id),
    FOREIGN KEY (doc_id, kind, idx) REFERENCES units (doc_id, kind, idx)
);
CREATE INDEX submission_requests_by_unit ON submission_requests (doc_id, kind, idx);
CREATE TABLE outputs (
    doc_id INTEGER NOT NULL REFERENCES documents (doc_id),
    path TEXT NOT NULL,
    format TEXT NOT NULL,
    sha256 TEXT,
    rendered_at TEXT,
    run_id TEXT REFERENCES runs (run_id),
    stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
    PRIMARY KEY (doc_id, path)
);
CREATE TABLE notes (
    note_id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER REFERENCES documents (doc_id),
    run_id TEXT REFERENCES runs (run_id),
    level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
);
`;

/** `common/store.py` _CORE_V2. */
export const CORE_V2 = `ALTER TABLE submission_requests ADD COLUMN request TEXT;`;

/** `common/classify_store.py` _V1. */
export const CLASSIFICATIONS_V1 = `
CREATE TABLE classification_rows (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT,
    document TEXT NOT NULL,
    doc_id INTEGER REFERENCES documents (doc_id),
    unit TEXT NOT NULL CHECK (unit IN ('page', 'chunk', 'entry', 'document')),
    locator TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    input_sha256 TEXT,
    content_sha256 TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    classifier TEXT NOT NULL,
    classifier_version INTEGER NOT NULL,
    classifier_sha256 TEXT NOT NULL,
    question TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('predicate', 'choice', 'score')),
    value,
    probability REAL,
    probabilities TEXT,
    refusal TEXT,
    model TEXT NOT NULL,
    dialect TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
    run_id TEXT REFERENCES runs (run_id),
    created_at TEXT NOT NULL,
    reused INTEGER NOT NULL DEFAULT 0 CHECK (reused IN (0, 1)),
    CHECK ((unit = 'entry') = (doc_id IS NOT NULL))
);
CREATE TRIGGER classification_rows_follow_documents BEFORE DELETE ON documents
BEGIN
    DELETE FROM classification_rows
    WHERE document = OLD.name OR doc_id = OLD.doc_id;
END;
CREATE INDEX classification_rows_by_answer ON classification_rows
    (document, unit, locator, classifier, question, stale);
CREATE INDEX classification_rows_by_ordinal ON classification_rows
    (document, unit, ordinal);
CREATE INDEX classification_rows_by_doc ON classification_rows (doc_id);
CREATE INDEX classification_rows_by_request ON classification_rows
    (document, request_sha256);
CREATE VIEW classifications AS
WITH live AS (
    SELECT r.* FROM classification_rows AS r
    WHERE r.stale = 0 AND NOT EXISTS (
        SELECT 1 FROM documents AS d
        WHERE d.name = r.document AND d.input_sha256 IS NOT NULL
        AND d.input_sha256 IS NOT r.input_sha256
    )
),
ranked AS (
    SELECT live.*,
        first_value(classifier_sha256) OVER (
            PARTITION BY document, unit, locator, classifier ORDER BY row_id DESC
        ) AS current_sha256,
        row_number() OVER (
            PARTITION BY document, unit, locator, classifier, question
            ORDER BY row_id DESC
        ) AS newest
    FROM live
)
SELECT
    document, doc_id, unit, locator, ordinal, input_sha256, content_sha256,
    request_sha256, classifier, classifier_version, classifier_sha256, question,
    kind, value, probability, probabilities, refusal, model, dialect,
    fingerprint, run_id, created_at, reused
FROM ranked
WHERE newest = 1 AND classifier_sha256 = current_sha256
ORDER BY document, unit, ordinal, locator, classifier, question;
`;

/** ChronoTranscriber `output/store.py` _VIEWS_V1. */
export const CT_VIEWS_V1 = `
CREATE VIEW page_text AS
SELECT
    d.name AS document,
    u.kind AS kind,
    CASE WHEN u.kind = 'page' AND typeof(u.source_index) = 'integer'
        THEN u.source_index END AS page_index,
    u.label AS image_name,
    u.idx AS order_index,
    u.content AS text,
    u.status AS status,
    u.model AS model,
    u.usage AS usage,
    u.outcome AS outcome,
    u.error AS error,
    u.provider AS provider,
    u.run_id AS run_id
FROM units AS u
JOIN documents AS d ON d.doc_id = u.doc_id
ORDER BY d.name, u.idx, u.kind;
CREATE VIEW document_status AS
SELECT
    name AS document,
    kind,
    input_path,
    status,
    units_total,
    units_done,
    units_failed,
    units_pending,
    last_run_id,
    updated_at
FROM documents
ORDER BY name;
CREATE VIEW page_attempts AS
SELECT
    d.name AS document,
    r.kind AS kind,
    r.idx AS order_index,
    r.response_id AS response_id,
    r.run_id AS run_id,
    r.provider AS provider,
    r.model AS model,
    r.attempt AS attempt,
    r.submission_id AS submission_id,
    r.custom_id AS custom_id,
    r.raw AS raw,
    r.raw_kind AS raw_kind,
    r.usage AS usage,
    r.error AS error,
    r.http_status AS http_status,
    r.created_at AS created_at
FROM responses AS r
LEFT JOIN documents AS d ON d.doc_id = r.doc_id
ORDER BY r.response_id;
`;

/** ChronoTranscriber `output/store.py` _PAGE_TYPES_V2 (version 3 adds nothing of its own). */
export const CT_PAGE_TYPES_V2 = `
CREATE TABLE page_types (
    doc_id INTEGER NOT NULL REFERENCES documents (doc_id),
    idx INTEGER NOT NULL,
    page_type TEXT NOT NULL,
    probabilities TEXT NOT NULL,
    taxonomy TEXT NOT NULL,
    profile TEXT NOT NULL,
    model TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    run_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (doc_id, idx)
);
DROP VIEW page_text;
CREATE VIEW page_text AS
SELECT
    d.name AS document,
    u.kind AS kind,
    CASE WHEN u.kind = 'page' AND typeof(u.source_index) = 'integer'
        THEN u.source_index END AS page_index,
    u.label AS image_name,
    u.idx AS order_index,
    u.content AS text,
    u.status AS status,
    u.model AS model,
    u.usage AS usage,
    u.outcome AS outcome,
    u.error AS error,
    u.provider AS provider,
    u.run_id AS run_id,
    pt.page_type AS page_type
FROM units AS u
JOIN documents AS d ON d.doc_id = u.doc_id
LEFT JOIN page_types AS pt
    ON pt.doc_id = u.doc_id AND pt.idx = u.idx AND u.kind = 'page'
ORDER BY d.name, u.idx, u.kind;
`;

/** ChronoMiner `output/store.py` _TABLES_V1 (run statement by statement, then the entries view). */
export const CM_TABLES_V1 = `
CREATE TABLE entry_rows (
    doc_id INTEGER NOT NULL REFERENCES documents (doc_id),
    kind TEXT NOT NULL DEFAULT 'chunk',
    idx INTEGER NOT NULL,
    entry_index INTEGER NOT NULL CHECK (entry_index >= 0),
    schema_name TEXT,
    run_id TEXT NOT NULL REFERENCES runs (run_id),
    tool TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    entry TEXT NOT NULL,
    PRIMARY KEY (doc_id, kind, idx, entry_index)
);
CREATE TABLE document_meta (
    doc_id INTEGER PRIMARY KEY REFERENCES documents (doc_id),
    metadata TEXT NOT NULL,
    schema_sha256 TEXT,
    run_id TEXT REFERENCES runs (run_id),
    updated_at TEXT
);
CREATE VIEW chunks AS
SELECT
    d.name AS document,
    u.idx + 1 AS chunk_index,
    u.source_index AS source_index,
    u.label AS label,
    u.status AS status,
    u.model AS model,
    u.provider AS provider,
    u.usage AS usage,
    u.content AS output_text,
    u.error AS error,
    u.error_type AS error_type,
    json_extract(u.provenance, '$.custom_id') AS custom_id,
    u.stale AS stale,
    u.run_id AS run_id
FROM units AS u
JOIN documents AS d ON d.doc_id = u.doc_id
WHERE u.kind = 'chunk'
ORDER BY d.name, u.idx;
CREATE VIEW ranges AS
SELECT
    d.name AS document,
    u.idx + 1 AS range_index,
    CAST(substr(u.source_index, 1, instr(u.source_index, '-') - 1) AS INTEGER)
        AS original_start,
    CAST(substr(u.source_index, instr(u.source_index, '-') + 1) AS INTEGER)
        AS original_end,
    json_extract(u.provenance, '$.decision.adjusted_range[0]') AS adjusted_start,
    json_extract(u.provenance, '$.decision.adjusted_range[1]') AS adjusted_end,
    json_extract(u.provenance, '$.decision.should_delete') AS should_delete,
    u.status AS status
FROM units AS u
JOIN documents AS d ON d.doc_id = u.doc_id
WHERE u.kind = 'range'
ORDER BY d.name, u.idx;
`;

/** ChronoMiner `output/store.py` _DECISIONS_V2. */
export const CM_DECISIONS_V2 = `
CREATE TABLE chunk_decisions (
    doc_id INTEGER NOT NULL REFERENCES documents (doc_id),
    idx INTEGER NOT NULL,
    probability REAL NOT NULL,
    question_sha256 TEXT NOT NULL,
    model TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    run_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (doc_id, idx)
);
DROP VIEW chunks;
CREATE VIEW chunks AS
SELECT
    d.name AS document,
    u.idx + 1 AS chunk_index,
    u.source_index AS source_index,
    u.label AS label,
    u.status AS status,
    u.model AS model,
    u.provider AS provider,
    u.usage AS usage,
    u.content AS output_text,
    u.error AS error,
    u.error_type AS error_type,
    json_extract(u.provenance, '$.custom_id') AS custom_id,
    u.stale AS stale,
    u.run_id AS run_id,
    u.outcome AS outcome,
    cd.probability AS decision_probability
FROM units AS u
JOIN documents AS d ON d.doc_id = u.doc_id
LEFT JOIN chunk_decisions AS cd ON cd.doc_id = u.doc_id AND cd.idx = u.idx
WHERE u.kind = 'chunk'
ORDER BY d.name, u.idx
`;

/** ChronoMiner `output/store.py` _TRIGGERS_V3. */
export const CM_TRIGGERS_V3 = `
CREATE TRIGGER chunk_layout_stale_on_update AFTER UPDATE ON units
WHEN OLD.kind = 'chunk' AND (
    OLD.source_index IS NOT NEW.source_index OR OLD.idx IS NOT NEW.idx
    OR OLD.doc_id IS NOT NEW.doc_id
)
BEGIN
    UPDATE classification_rows SET stale = 1
    WHERE stale = 0 AND unit = 'chunk'
    AND document = (SELECT name FROM documents WHERE doc_id = OLD.doc_id);
END;
CREATE TRIGGER chunk_layout_stale_on_delete AFTER DELETE ON units
WHEN OLD.kind = 'chunk'
BEGIN
    UPDATE classification_rows SET stale = 1
    WHERE stale = 0 AND unit = 'chunk'
    AND document = (SELECT name FROM documents WHERE doc_id = OLD.doc_id);
END;
CREATE TRIGGER entry_rows_stale_on_insert AFTER INSERT ON entry_rows
BEGIN
    UPDATE classification_rows SET stale = 1
    WHERE stale = 0 AND doc_id = NEW.doc_id AND request_sha256 IN (
        SELECT request_sha256 FROM classification_rows
        WHERE doc_id = NEW.doc_id AND unit = 'entry'
        AND ordinal = NEW.idx + 1 AND stale = 0
    );
END;
CREATE TRIGGER entry_rows_stale_on_delete AFTER DELETE ON entry_rows
BEGIN
    UPDATE classification_rows SET stale = 1
    WHERE stale = 0 AND doc_id = OLD.doc_id AND request_sha256 IN (
        SELECT request_sha256 FROM classification_rows
        WHERE doc_id = OLD.doc_id AND unit = 'entry'
        AND ordinal = OLD.idx + 1 AND stale = 0
    );
END;
CREATE TRIGGER entry_rows_stale_on_update AFTER UPDATE ON entry_rows
BEGIN
    UPDATE classification_rows SET stale = 1
    WHERE stale = 0 AND doc_id = OLD.doc_id AND request_sha256 IN (
        SELECT request_sha256 FROM classification_rows
        WHERE doc_id = OLD.doc_id AND unit = 'entry'
        AND ordinal = OLD.idx + 1 AND stale = 0
    );
    UPDATE classification_rows SET stale = 1
    WHERE stale = 0 AND doc_id = NEW.doc_id AND request_sha256 IN (
        SELECT request_sha256 FROM classification_rows
        WHERE doc_id = NEW.doc_id AND unit = 'entry'
        AND ordinal = NEW.idx + 1 AND stale = 0
    );
END;
CREATE TRIGGER chunk_units_stale_on_update AFTER UPDATE ON units
WHEN OLD.kind = 'chunk' AND (
    OLD.status IS NOT NEW.status OR OLD.stale IS NOT NEW.stale
    OR OLD.run_id IS NOT NEW.run_id OR OLD.content IS NOT NEW.content
    OR OLD.idx IS NOT NEW.idx OR OLD.doc_id IS NOT NEW.doc_id
)
BEGIN
    UPDATE classification_rows SET stale = 1
    WHERE stale = 0 AND doc_id = OLD.doc_id AND request_sha256 IN (
        SELECT request_sha256 FROM classification_rows
        WHERE doc_id = OLD.doc_id AND unit = 'entry'
        AND ordinal = OLD.idx + 1 AND stale = 0
    );
END;
CREATE TRIGGER chunk_units_stale_on_delete AFTER DELETE ON units
WHEN OLD.kind = 'chunk'
BEGIN
    UPDATE classification_rows SET stale = 1
    WHERE stale = 0 AND doc_id = OLD.doc_id AND request_sha256 IN (
        SELECT request_sha256 FROM classification_rows
        WHERE doc_id = OLD.doc_id AND unit = 'entry'
        AND ordinal = OLD.idx + 1 AND stale = 0
    );
END;
`;
