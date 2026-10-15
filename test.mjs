import assert from "node:assert/strict";
import { decide, items } from "./server.mjs";

// items() digs scored entities out of any envelope shape.
assert.deepEqual(items({ results: { entities: [{ name: "A", id: "1", score: 0.9 }, { name: "B", affinity: 0.4 }] } }),
  [{ id: "1", name: "A", score: 0.9 }, { id: "B", name: "B", score: 0.4 }]);

// Ana loves X, Ben hates X; Y is decent for both -> maximin picks Y, Ana-only would pick X.
const members = [{ name: "Ana" }, { name: "Ben" }];
const r = decide(members, [
  [{ name: "X", score: 1.0 }, { name: "Y", score: 0.7 }],
  [{ name: "X", score: 0.1 }, { name: "Y", score: 0.8 }],
]);
assert.equal(r.pick.name, "Y");
assert.equal(r.loudestPick.name, "X");
assert.ok(r.pick.worst > r.loudestPick.worst);
console.log("PASS", r.pick.name, r.pick.worst.toFixed(2), "vs loudest", r.loudestPick.name, r.loudestPick.worst.toFixed(2));
