// Test-only worker that never replies and never exits, simulating the wedged
// worker class (stuck in native SQLite/fsync, unresponsive to the heap
// sampler) behind the #176080 worker-wedge path. The host-side settlement
// timeout must terminate it and free its queue slot / reconcile owner.
import { parentPort } from "node:worker_threads";

parentPort?.on("message", () => {
  // Intentionally never post back; keep the thread alive until terminated.
});
