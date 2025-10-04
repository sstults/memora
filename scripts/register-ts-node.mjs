import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Clean ts-node ESM registration without using --experimental-loader.
// This mirrors Node's suggested pattern from the warning output.
register("ts-node/esm", pathToFileURL("./"));
