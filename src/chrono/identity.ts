import { statSync } from "node:fs";
import { basename } from "node:path";
import { listFolderImages } from "./paths.ts";
import { pyJsonDumps } from "./py.ts";
import { fileSha256, textSha256 } from "./store.ts";

/**
 * The `input_sha256` a store document records (CT `sources/identity.py`): a file's SHA-256, or for an image folder
 * the SHA-256 of `json.dumps([[name, sha256], ...], ensure_ascii=False)` over its images in page order.
 */
export function inputIdentity(path: string): string {
	if (!statSync(path).isDirectory()) {
		const digest = fileSha256(path);
		if (!digest) throw new Error(`No such file: ${path}`);
		return digest;
	}
	const listing = listFolderImages(path).map((image) => {
		const digest = fileSha256(image);
		if (!digest) throw new Error(`No such file: ${image}`);
		return [basename(image), digest];
	});
	return textSha256(Buffer.from(pyJsonDumps(listing), "utf8"));
}
