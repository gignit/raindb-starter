# M2 formation shapes (codex research, coder-cited) -- author these ff-* on vector-sandbox1

Shared header on every config: {configVersion:1, minSchemaVersion:1, maxSchemaVersion:1,
compatibleSchemas:["v1"]}. All templates tenant-RELATIVE (path_template_validate.go:107).
Desc indexes: pointer/write + unique /meta.json entryTemplate + {{.setId}}/meta.json setsTemplate
(index_chain_validation.go:61). SQL block source must name an existing pointer index
(tier_policy_validation.go:457); tier paths omittable (174).

SQL BLOCK (add to SQL-enabled STANDARD formations only -- ff-journal, ff-workout-sets, optionally
ff-workout-categories): actions:[{action:"periscope-pool", trigger:"onDroplet", metadata:{tier:"stream"}}]
+ queryConfig{enabled:true, flattenDepth:1, defaultLimit:100, maxLimit:1000} + tierPolicy{partition:
{strategy:"formation"}, tiers:{stream:{enabled:true, source:{type:"droplets", index:"<by-update>"},
trigger:{next:"*/5 * * * *", operator:"OR", tz:"UTC"}, retainInputs:true, retention:{afterSupersession:"30d"}}}}
+ views{defaultBehavior:{dedup:true}, queryDefaults:{autoPool:true, window:"10s"}}.

TOKEN VERDICT (critical): token formations get NEITHER SQL tiers NOR desc indexes -- WriteToken only
calls writeTokenIndexes (ordinary indexes, no desc-chain, no periscope pipeline; token.go:469,878).
So ff-config/ff-stats/ff-streaks/ff-journal-draft/ff-tags/ff-workout-session = plain by-id pointer only.
Token schemas: additionalProperties:true (server adds createdAt/updatedAt/expiresAt/__concurrency before
validation, token.go:192,311).

1. ff-users (standard): scopeKey userId, autoGenId. indexes by-id + by-email (both pointer/write). schema
   required[userId,email,passwordHash,displayName,createdAt] (uuid/email formats). NORMALIZE email before write.
2. ff-config (token): scopeKey configId, lifecycle{expirationMode:none, autoCache:true, cacheTTL:1h}, by-id.
   schema addlProps:true required[configId]; appName/logoUrl/inviteOnly/theme(object).
3. ff-stats (token, COUNTER): scopeKey statsId, lifecycle{none, autoCache:true, cacheTTL:30s, writeDelay:30s,
   wireOpDelayMs:100}, stats{enabled:true, keepRunningTotals:true, fields:[workouts/sets/volumeKg/journalEntries
   (op:increment)]}, by-id. schema required[statsId,counters] counters(object addlProps). keepRunningTotals ->
   counters.delta.* + counters.total.* (stats.go:32). windowed active-users under counters.window.*.
4. ff-streaks (token): scopeKey userId, lifecycle{none, autoCache, cacheTTL:1h, writeDelay:30s, wireOpDelayMs:100},
   NO stats block (drain would reset current/longest -- they're mutable state; mutate directly), by-id.
   schema counters{current(int>=0), longest(int>=0), lastActivityDate}.
5. ff-journal (standard, SQL): scopeKey entryId, autoGenId. indexes by-id + by-author(desc, carryFields entryId/
   authorName/title/encrypted/tags/updatedAt/revisionNote + latestPointerTemplate) + by-update(desc). SQL source
   by-update. schema addlProps:FALSE required[entryId,authorName,title,encrypted,tags,createdAt,updatedAt];
   authorName(NOT author -- overwritten by write author, write.go:381); ciphertext; allOf if encrypted:true ->
   require ciphertext else require body.
6. ff-journal-draft (token, = proven harness-draft-token-v1): scopeKey draftId, lifecycle{autoCache, cacheTTL:30s,
   writeDelay:30s, wireOpDelayMs:100, expirationMode:fixed, expirationDuration:24h}, by-id. schema addlProps:true
   required[draftId,userId]; body/ciphertext/encrypted/title/tags.
7. ff-tags (token): scopeKey tagScopeId (COMPOSITE "<userId>:journal"|"<userId>:workout"), lifecycle{none,
   autoCache, cacheTTL:1h}, by-id. schema required[tagScopeId,userId,scope,tags]; scope enum[journal,workout];
   tags unique string array. NOTE: actual token key is tenants/<t>/tokens/ff-tags/<4char-fanout>/<userId>:journal.json
   (WriteToken ignores config renderer -> TokenObjectPath fan-out, token.go:84/paths.go:329). Composite value still
   gives journal/workout isolation.
8. ff-workout-categories (standard, optional-SQL): scopeKey categoryId, autoGenId. indexes by-id + by-parent
   (template includes {{.userId}}/{{.parentId}}/{{.categoryId}} -- per-user root; root category parentId="root").
   schema addlProps:FALSE required[categoryId,userId,parentId,name,metricSchema]; metricSchema{fields[](array of
   objects), chartHint, benchmarkable}. Move-category MUST use the update path w/ prior payload (orphan purge needs
   PriorPayload, write.go:1371). Add SQL(source by-id) only if categories must join cross-formation.
9. ff-workout-sets (standard, SQL): scopeKey setId, autoGenId. indexes by-id + by-category(SINGLE pointer
   .../{{.categoryId}}/latest.json -- safe since categoryId is UUIDv7-unique; +desc carryFields) + by-benchmark
   (condition "isBenchmark == true", +desc) + by-update(desc). SQL source by-update. schema addlProps:FALSE
   required[setId,userId,sessionId,categoryId,categoryName,categoryPath,isBenchmark,recordedAt]; TYPED metric cols
   weightKg/reps/distanceM/durationS/avgHeartRateBpm/elevationM/rpe (all [type,null]) + metrics(object) + isBenchmark.
   flattenDepth:1 keeps metrics a JSON col while typed cols emit directly (schema_mapper.go:203 -- top-level always
   columns; NO flattenDepth:2 needed).
10. ff-workout-session (token): scopeKey sessionId, lifecycle{expirationMode:recycle, expirationDuration:24h,
    autoCache, cacheTTL:1h}, by-id. schema addlProps:true required[sessionId,userId,status,startedAt];
    currentCategoryId/setNumber/completedCategoryIds/draft metrics.
11. ff-photos (standard, revisions float): scopeKey photoId, autoGenId. indexes by-id + by-user(desc). floatConfig
    fields[{sourceField:image, contentTypeField:imageContentType, filenameField:imageFilename, pathTemplate:
    floats/ff-photos/{{.photoId}}/{{.filename}}, stripAfterFloat:true, downloadDisposition:inline, revisions:true}].
    schema addlProps:FALSE required[photoId,userId,imageContentType,imageFilename,capturedAt] -- do NOT require image
    (CDU delivers binary out of band). revisions:true injects imageVersionId + ver/{{.imageVersionId}}/ + by-id
    (revisions.go:151,201; augmentation before compile so strict schema OK, build.go:142).

## PEER-REVIEW VERDICTS (lead-eng, coder-authoritative -- validated codex, not trusted)
- descIndex entryTemplate leaf: MUST bind a UUIDv7 var from the allowlist
  {.dropletId,.messageId,.eventId,.sessionId,.relayId} (index_chain_validation.go:333,351).
  ALL codex descIndex templates use {{.dropletId}} -> PASS. (This is the exact rule that killed
  the old starter -- confirmed safe.)
- descIndex setsTemplate MUST contain literal {{.setId}} + end /meta.json; entryTemplate ends
  /meta.json + non-static leaf; latestPointerTemplate ends /latest.json + != entryTemplate
  (index_chain_validation.go:289,412,394). codex shapes comply -> PASS.
- Conditional index "isBenchmark == true": VALID. EvaluateIndexCondition (index_condition.go:32)
  grammar is <field> <op> <value>; conditionEqual (line 149-150) renders bool via
  fmt.Sprintf("%v",v) so bool true matches string "true" -> PASS.
- Token verdict (no SQL/desc on token formations): codex correct (WriteToken skips periscope+desc,
  token.go:469/878). ff-tags path is canonical sharded TokenObjectPath (composite scopeKey gives
  isolation) -- codex corrected this himself.
VERDICT: codex's 11 ff-* shapes are validator-safe on the highest-risk rules. APPROVED to author
in M2 (with the shared header + the SQL block only on ff-journal/ff-workout-sets[/categories]).
