/**
 * Python semantics that the ChronoTranscriber and ChronoMiner files depend on: `str.strip`, code-point lengths,
 * `Path.stem` and `Path.suffix`, `json.dumps` with its separators and float repr, and natural sort keys.
 */

/** The characters Python's `str.strip()` and `str.isspace()` treat as whitespace. */
const PY_WHITESPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEADING = new RegExp(`^[${PY_WHITESPACE}]+`, "u");
const TRAILING = new RegExp(`[${PY_WHITESPACE}]+$`, "u");

/** Python's `str.strip()` without arguments. */
export function pyStrip(text: string): string {
	return text.replace(LEADING, "").replace(TRAILING, "");
}

/** Python's `\s` in a str pattern (Unicode whitespace). */
export const PY_SPACE = `[${PY_WHITESPACE}]`;

/** Number of code points (Python `len` of a str). */
export function pyLen(text: string): number {
	let count = 0;
	for (const _ of text) count++;
	return count;
}

/** The first `count` code points (Python `text[:count]`). */
export function pySlice(text: string, count: number): string {
	if (count <= 0) return "";
	let out = "";
	let taken = 0;
	for (const char of text) {
		if (taken >= count) break;
		out += char;
		taken++;
	}
	return out;
}

/** Python's `str.rstrip(chars)`. */
export function pyRstrip(text: string, chars: string): string {
	let end = text.length;
	while (end > 0 && chars.includes(text[end - 1])) end--;
	return text.slice(0, end);
}

/** `PurePath(name).suffix` of a final path component (Python 3.13 rules: no suffix for a trailing dot). */
export function pySuffix(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 && dot < name.length - 1 ? name.slice(dot) : "";
}

/** `PurePath(name).stem` of a final path component. */
export function pyStem(name: string): string {
	const suffix = pySuffix(name);
	return suffix ? name.slice(0, name.length - suffix.length) : name;
}

/** Python's `repr(float)`: the shortest round-trip digits, scientific below 1e-4 and from 1e16 on. */
export function pyFloatRepr(value: number): string {
	if (Number.isNaN(value)) return "NaN";
	if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
	if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
	const exponential = value.toExponential();
	const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exponential);
	if (!match) return String(value);
	const [, sign, first, rest = "", exp] = match;
	const digits = `${first}${rest}`;
	const exponent = Number.parseInt(exp, 10);
	if (exponent < -4 || exponent >= 16) {
		const mantissa = rest ? `${first}.${rest}` : first;
		const magnitude = Math.abs(exponent);
		return `${sign}${mantissa}e${exponent < 0 ? "-" : "+"}${String(magnitude).padStart(2, "0")}`;
	}
	if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
	const whole = digits.length > exponent + 1 ? digits.slice(0, exponent + 1) : digits.padEnd(exponent + 1, "0");
	const fraction = digits.length > exponent + 1 ? digits.slice(exponent + 1) : "0";
	return `${sign}${whole}.${fraction}`;
}

/**
 * A JS number as Python reads it back from the JSON this module writes: integers below 1e21 are written as digits
 * (Python ints); everything else is a float.
 */
export function pyNumber(value: number): string {
	if (Number.isInteger(value) && Math.abs(value) < 1e21) return Object.is(value, -0) ? "0" : String(value);
	return pyFloatRepr(value);
}

/**
 * A JSON number whose Python value a JS number does not keep: an integral float (`1.0`, a Python float) or an
 * integer beyond 2^53 (a Python int). `text` is how Python writes it back; JSON.stringify writes `value`.
 */
export class PyNumberLexeme {
	readonly value: number;
	readonly text: string;
	readonly isFloat: boolean;

	constructor(value: number, text: string, isFloat: boolean) {
		this.value = value;
		this.text = text;
		this.isFloat = isFloat;
	}

	/** JSON.stringify writes the Python form as it is (`1.0`, `9007199254740993`). */
	toJSON(): unknown {
		return (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(this.text);
	}
}

/**
 * `json.loads` as far as the numbers go: integral floats and large integers become PyNumberLexeme, so that
 * pyJsonDumps and the CSV cells write them as Python does. Needs the reviver's source text (Node 21 and later).
 */
export function pyJsonParse(text: string): unknown {
	const reviver = (_key: string, value: unknown, context?: { source?: string }): unknown => {
		const source = context?.source;
		if (typeof value !== "number" || source === undefined) return value;
		if (/[.eE]/.test(source))
			return Number.isInteger(value) ? new PyNumberLexeme(value, pyFloatRepr(value), true) : value;
		return Number.isSafeInteger(value) ? value : new PyNumberLexeme(value, BigInt(source).toString(), false);
	};
	return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

/** JSON string literal as Python's `json.dumps(..., ensure_ascii=False)` writes it. */
function pyString(value: string): string {
	return JSON.stringify(value);
}

/**
 * Python's `json.dumps(value, ensure_ascii=False)`, or with `indent` the `json.dumps(value, indent=n,
 * ensure_ascii=False)` form. Without an indent the separators are `", "` and `": "`; with one, `","` and `": "`.
 */
export function pyJsonDumps(value: unknown, indent?: number): string {
	const write = (item: unknown, level: number): string => {
		if (item === null || item === undefined) return "null";
		if (typeof item === "boolean") return item ? "true" : "false";
		if (typeof item === "number") return pyNumber(item);
		if (typeof item === "bigint") return item.toString();
		if (item instanceof PyNumberLexeme) return item.text;
		if (typeof item === "string") return pyString(item);
		const pad = indent === undefined ? "" : `\n${" ".repeat(indent * (level + 1))}`;
		const close = indent === undefined ? "" : `\n${" ".repeat(indent * level)}`;
		const separator = indent === undefined ? ", " : ",";
		if (Array.isArray(item)) {
			if (item.length === 0) return "[]";
			return `[${item.map((child) => `${pad}${write(child, level + 1)}`).join(separator)}${close}]`;
		}
		const entries = Object.entries(item as Record<string, unknown>).filter(([, child]) => child !== undefined);
		if (entries.length === 0) return "{}";
		return `{${entries.map(([key, child]) => `${pad}${pyString(key)}: ${write(child, level + 1)}`).join(separator)}${close}}`;
	};
	return write(value, 0);
}

/** Compare two strings by code points (Python's str ordering). */
export function comparePy(a: string, b: string): number {
	const left = [...a];
	const right = [...b];
	const length = Math.min(left.length, right.length);
	for (let i = 0; i < length; i++) {
		const x = left[i].codePointAt(0) as number;
		const y = right[i].codePointAt(0) as number;
		if (x !== y) return x < y ? -1 : 1;
	}
	return left.length - right.length < 0 ? -1 : left.length > right.length ? 1 : 0;
}

const DECIMAL = /\p{Nd}/u;

/** Numeric value of a run of Unicode decimal digits (each block of ten digits starts at its zero). */
function digitsValue(run: string): bigint {
	let value = 0n;
	for (const char of run) {
		const code = char.codePointAt(0) as number;
		// Decimal digits come in contiguous blocks of ten that start at their zero.
		let below = 0;
		while (DECIMAL.test(String.fromCodePoint(code - below - 1))) below++;
		value = value * 10n + BigInt(below % 10);
	}
	return value;
}

type KeyPart = string | bigint;

/** `natural_sort_key(name)` of ChronoTranscriber and ChronoMiner: the lower-cased name split into text and numbers. */
export function naturalSortKey(name: string): KeyPart[] {
	const parts = name.toLowerCase().split(/(\p{Nd}+)/u);
	return parts.map((part) => (/^\p{Nd}+$/u.test(part) ? digitsValue(part) : part));
}

/** Compare two natural sort keys as Python compares the lists. */
export function compareKeys(a: KeyPart[], b: KeyPart[]): number {
	const length = Math.min(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const x = a[i];
		const y = b[i];
		if (typeof x === "bigint" && typeof y === "bigint") {
			if (x !== y) return x < y ? -1 : 1;
		} else {
			const order = comparePy(String(x), String(y));
			if (order !== 0) return order;
		}
	}
	return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** ChronoTranscriber's page order of folder images: natural order, ties broken by the file name. */
export function comparePageOrder(a: string, b: string): number {
	return compareKeys(naturalSortKey(a), naturalSortKey(b)) || comparePy(a, b);
}

/** Python's `str.casefold()` for the collision checks (lower case after full case folding of common letters). */
export function pyCasefold(text: string): string {
	return text.toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ");
}
