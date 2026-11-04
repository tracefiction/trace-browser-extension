/** The standalone Keep a Copy extension's background entry (scripts/build-keep-a-copy.mjs). */

import { installKeepACopy, type Extension } from "./keep-a-copy-runtime.mjs";

const scope = globalThis as unknown as { browser?: Extension; chrome?: Extension };
const extension = scope.browser ?? scope.chrome;
if (extension?.downloads) installKeepACopy(extension);
