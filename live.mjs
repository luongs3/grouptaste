// Live run against the real Qloo hackathon API; records every qloo call as a fixture.
import { writeFileSync } from "node:fs";
import * as S from "./server.mjs";

const group = {
  city: "New York", kind: "bar",
  venues: [],
  members: [
    { name: "Ana", loves: ["Radiohead", "Wes Anderson", "Sideways"] },
    { name: "Ben", loves: ["Metallica", "Fast & Furious", "Guy Fieri"] },
    { name: "Chi", loves: ["Taylor Swift", "Gilmore Girls", "Pride and Prejudice"] },
  ],
};
const t0 = Date.now();
const r = await S.plan(group);
console.log(JSON.stringify({ pick: r.pick, loudestPick: r.loudestPick.name,
  ranked: r.ranked.map((v) => [v.name, v.scores.map((s) => +s.toFixed(2)), +v.worst.toFixed(2)]) }, null, 1));
console.log("ms", Date.now() - t0);
writeFileSync("fixtures/demo.json", JSON.stringify(S.recorded(), null, 1));
