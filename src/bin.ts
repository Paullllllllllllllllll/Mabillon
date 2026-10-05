#!/usr/bin/env node
import { cli } from "./cli.ts";

/** Exit once stdout and stderr are flushed (pipes are asynchronous on some platforms; large --json output). */
function exit(code: number): void {
	process.exitCode = code;
	process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

const argv = process.argv.slice(2);
cli(argv).then(
	(code) => {
		// The TUI manages its own lifetime (unless it could not start); everything else exits with the command's status.
		if (argv[0] !== "tui" || code !== 0) exit(code);
	},
	(error: unknown) => {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		exit(1);
	},
);
