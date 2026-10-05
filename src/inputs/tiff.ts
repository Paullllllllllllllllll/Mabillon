import { closeSync, openSync, readSync } from "node:fs";

const NEW_SUBFILE_TYPE = 254;
const MAX_DIRECTORIES = 100_000;

/**
 * NewSubfileType (tag 254) of every directory in a TIFF's main chain, in page order; bit 0 marks a reduced-resolution
 * copy of another page (pyramid level, thumbnail). Returns undefined when the file cannot be read as a TIFF.
 */
export function tiffSubfileTypes(path: string): number[] | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const handle = fd;
		const read = (position: number, length: number) => {
			const buffer = Buffer.alloc(length);
			const bytes = readSync(handle, buffer, 0, length, position);
			if (bytes < length) throw new Error("truncated TIFF");
			return buffer;
		};
		const header = read(0, 16);
		const order = header.toString("latin1", 0, 2);
		if (order !== "II" && order !== "MM") return undefined;
		const little = order === "II";
		const u16 = (buffer: Buffer, at: number) => (little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
		const u32 = (buffer: Buffer, at: number) => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
		const u64 = (buffer: Buffer, at: number) =>
			Number(little ? buffer.readBigUInt64LE(at) : buffer.readBigUInt64BE(at));
		const magic = u16(header, 2);
		if (magic !== 42 && magic !== 43) return undefined;
		const big = magic === 43;
		const entrySize = big ? 20 : 12;
		const valueAt = big ? 12 : 8;
		const types: number[] = [];
		const seen = new Set<number>();
		let offset = big ? u64(header, 8) : u32(header, 4);
		while (offset > 0 && !seen.has(offset) && types.length < MAX_DIRECTORIES) {
			seen.add(offset);
			const count = big ? u64(read(offset, 8), 0) : u16(read(offset, 2), 0);
			const body = read(offset + (big ? 8 : 2), count * entrySize + (big ? 8 : 4));
			let type = 0;
			for (let i = 0; i < count; i++) {
				const at = i * entrySize;
				if (u16(body, at) !== NEW_SUBFILE_TYPE) continue;
				type = u16(body, at + 2) === 3 ? u16(body, at + valueAt) : u32(body, at + valueAt);
			}
			types.push(type);
			offset = big ? u64(body, count * entrySize) : u32(body, count * entrySize);
		}
		return types;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
