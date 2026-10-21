// Entry point so `node --test genui-lab/wondering-genui/test/` works: Node resolves a
// directory argument to its index.js. When the runner discovers files itself
// (`node --test` with no args) it also picks this file up by name, so it only
// pulls the suites in when it was reached through the directory path.
import { basename } from "node:path";

if (basename(process.argv[1] ?? "") !== "index.js") {
  await import("./markers.test.js");
  await import("./embeds.test.js");
  await import("./markdown.test.js");
  await import("./components.test.js");
  await import("./voice-visuals.test.js");
  await import("./sse.test.js");
  await import("./fsrs.test.js");
}
