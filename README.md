# GroupTaste — the place everyone actually likes

**Live demo:** https://deploytest.theodoikenh.com/grouptaste/
**Built for:** Qloo Agentic Hackathon · MIT licensed

## Problem
Groups pick bars and restaurants by whoever talks loudest. That place is great for one person and a bad night for someone else. Nobody can see that until they're already there.

## What it does
Each person lists a few things they love (artists, films, shows, books, brands). GroupTaste:
1. **Resolves** each "love" to a Qloo entity (search, keeping cultural entities only, never places).
2. **Proposes** candidate venues: each member's top Qloo `recommend` places in the city (optional bar/restaurant tag). Places whose geocoded city isn't the chosen city are dropped, because `filter_location` is a radius, not a city boundary.
3. **Scores** every candidate against **each member's taste separately** with Qloo `rank`, so every person gets their own affinity for the same set of real places.
4. **Decides** by **maximin**: the venue with the best *least-happy-member* score, with mean affinity as the tie-breaker.
5. **Shows the evidence**: a per-member affinity table, plus what "pick for the first person" would have chosen and who that choice would leave out.

Sample run (live API, New York, bar; Ana: Radiohead/Wes Anderson/Sideways · Ben: Metallica/Fast & Furious/Guy Fieri · Chi: Taylor Swift/Gilmore Girls/Pride and Prejudice):
**Igloo Bar NYC**. Affinities: Ana 0.86 · Ben 0.85 · Chi 0.87. The least-happy member is at 0.85.

## Qloo workflow used
`@qloo/qloo-harness` (`qloo api search`, `qloo exec recommend`, `qloo exec rank`) against `https://hackathon.api.qloo.com`.
- Entity ambiguity: the harness's `needs_input` candidates are resolved deterministically (city match first, then popularity) and re-run once.
- Request to result: likes → entity ids → `recommend {target_type: place, signals: [ids], filter_location, include_tags}` → candidate place ids → `rank {options: place ids, option_type: place, signals: member ids}` per member → maximin.

## Run it
```
npm i -g @qloo/qloo-harness            # needs Node >= 22
export QLOO_API_KEY=...  QLOO_BASE_URL=https://hackathon.api.qloo.com  QLOO_TRUSTED_BASE_URL=$QLOO_BASE_URL
node server.mjs                        # http://localhost:8809
GROUPTASTE_FIXTURES=fixtures/demo.json node server.mjs   # keyless replay of a recorded live run
node test.mjs                          # decision-logic test
```
Optional `GROUPTASTE_CACHE=cache.json` persists Qloo answers, so repeated groups don't spend the key's rate budget.

## Limits
- Affinity is Qloo's taste signal, not a forecast of anyone's evening. Price, distance and opening hours are not considered.
- The hackathon key is rate-limited, so a brand-new group takes about a minute. Calls are serialized, with backoff on `QLOO_RATE_LIMIT`.
- Maximin protects the least-happy member, and it can pass over a place two people love that the third merely tolerates. That trade-off is the point, and it's shown in the table.
- No personal data is stored. Member names are free text and only stay in memory for the request.
