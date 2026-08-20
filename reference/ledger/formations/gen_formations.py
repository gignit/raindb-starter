#!/usr/bin/env python3
"""Emit the FitLedger reference-bolt formation config+schema JSON files.

Config-as-data: every ref-* formation is declared here from the peer-reviewed,
coder-validated shapes in docs/M2_FORMATION_SHAPES.md, then written to disk as
<id>-config.json / <id>-schema.json. Run once; publish with publish.sh.

Naming: the reference bolt uses the ref-* prefix (matches ref-entries); a user's
own app/ formations use their own prefix, so the two never collide.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
HEADER = {"configVersion": 1, "minSchemaVersion": 1, "maxSchemaVersion": 1, "compatibleSchemas": ["v1"]}


def sql_block(source_index):
    return {
        "actions": [{"action": "periscope-pool", "trigger": "onDroplet", "metadata": {"tier": "stream"}}],
        "queryConfig": {"enabled": True, "flattenDepth": 1, "defaultLimit": 100, "maxLimit": 1000},
        "tierPolicy": {
            "partition": {"strategy": "formation"},
            "catalog": {"location": "periscope/{{.formationId}}/catalog"},
            "tiers": {
                "stream": {
                    "enabled": True,
                    "source": {"type": "droplets", "index": source_index},
                    "trigger": {"operator": "OR", "next": "*/5 * * * *", "tz": "UTC"},
                    "retainInputs": True,
                    "retention": {"afterSupersession": "30d"},
                }
            },
        },
        "views": {"defaultBehavior": {"dedup": True}, "queryDefaults": {"autoPool": True, "window": "10s"}},
    }


def ptr(name, template, desc=None, condition=None):
    idx = {"name": name, "template": template, "type": "pointer", "strategy": "write"}
    if condition:
        idx["condition"] = condition
    if desc:
        idx["descIndex"] = desc
    return idx


def desc(f, index, scope, carry, per_scope=True):
    """Build a descIndex block. Leaf is always {{.dropletId}} (UUIDv7 allowlist)."""
    base = f"indexes/{f}/{index}"
    seg = f"{scope}/" if per_scope and scope else ""
    d = {
        "enabled": True,
        "entryTemplate": f"{base}.desc/{seg}{{{{.dropletId}}}}/meta.json",
        "setsTemplate": f"{base}.sets/{seg}{{{{.setId}}}}/meta.json",
        "carryFields": carry,
    }
    if per_scope and scope:
        d["latestPointerTemplate"] = f"{base}.desc/{scope}/latest.json"
    return d


def token_cfg(fid, scope_key, lifecycle, extra=None):
    cfg = dict(HEADER)
    cfg.update({
        "formationId": fid,
        "formationType": "token",
        "scopeKey": scope_key,
        "pathTemplate": f"tokens/{fid}/{{{{.{scope_key}}}}}.json",
        "lifecycle": lifecycle,
        "indexes": [ptr("by-id", f"indexes/{fid}/by-id/{{{{.{scope_key}}}}}/latest.json")],
    })
    if extra:
        cfg.update(extra)
    return cfg


def std_cfg(fid, scope_key, indexes, extra=None):
    cfg = dict(HEADER)
    cfg.update({
        "formationId": fid,
        "formationType": "standard",
        "scopeKey": scope_key,
        "autoGenId": True,
        "pathTemplate": f"entities/{fid}/{{{{.{scope_key}}}}}/{{{{.yyyy}}}}/{{{{.mm}}}}/{{{{.dd}}}}/{{{{.dropletId}}}}.json",
        "indexes": indexes,
    })
    if extra:
        cfg.update(extra)
    return cfg


FORMATIONS = {}

# ref-session: revocable session token (modeled on raindb-app platform_session).
# JWT carries the sessionId; requireUser verifies the JWT AND reads this token
# (autoExtend on read = silent session extension), so logout DELETES the token
# and the session is instantly revoked -- a JWT-only cookie could never revoke.
FORMATIONS["ref-session"] = (
    {**HEADER, "formationId": "ref-session", "formationType": "token", "scopeKey": "sessionId",
     "autoGenId": True, "pathTemplate": "tokens/ref-session/{{.sessionId}}.json",
     "lifecycle": {"expirationMode": "recycle", "expirationDuration": "30d", "autoExtend": True, "cacheTTL": "1h"},
     "indexes": [
         ptr("by-id", "indexes/ref-session/by-id/{{.sessionId}}/latest.json"),
         ptr("by-userid", "indexes/ref-session/by-userid/{{.userId}}/{{.sessionId}}/latest.json")]},
    {"type": "object", "additionalProperties": True, "required": ["sessionId", "userId", "email"], "properties": {
        "sessionId": {"type": "string"}, "userId": {"type": "string"}, "email": {"type": "string"},
        "name": {"type": "string"}, "role": {"type": "string"}, "userAgent": {"type": "string"}, "ip": {"type": "string"}}},
)

# ref-config: white-label brand token.
FORMATIONS["ref-config"] = (
    token_cfg("ref-config", "configId", {"expirationMode": "none", "autoCache": True, "cacheTTL": "1h"}),
    {"type": "object", "additionalProperties": True, "required": ["configId"], "properties": {
        "configId": {"type": "string"}, "appName": {"type": "string"}, "logoUrl": {"type": "string"},
        "inviteOnly": {"type": "boolean"}, "theme": {"type": "object", "additionalProperties": True}}},
)

# ref-stats: community odometer counter token (keepRunningTotals -> counters.delta/total).
FORMATIONS["ref-stats"] = (
    token_cfg("ref-stats", "statsId",
              {"expirationMode": "none", "autoCache": True, "cacheTTL": "30s", "writeDelay": "30s", "wireOpDelayMs": 100},
              {"stats": {"enabled": True, "keepRunningTotals": True, "fields": [
                  {"name": "workouts", "op": "increment"}, {"name": "sets", "op": "increment"},
                  {"name": "volumeKg", "op": "increment"}, {"name": "journalEntries", "op": "increment"}]}}),
    {"type": "object", "additionalProperties": True, "required": ["statsId", "counters"], "properties": {
        "statsId": {"type": "string"}, "counters": {"type": "object", "additionalProperties": True}}},
)

# ref-streaks: per-user streak token, NO stats (mutate directly).
FORMATIONS["ref-streaks"] = (
    token_cfg("ref-streaks", "userId",
              {"expirationMode": "none", "autoCache": True, "cacheTTL": "1h", "writeDelay": "30s", "wireOpDelayMs": 100}),
    {"type": "object", "additionalProperties": True, "required": ["userId", "counters"], "properties": {
        "userId": {"type": "string"}, "counters": {"type": "object", "additionalProperties": True, "properties": {
            "current": {"type": "integer", "minimum": 0}, "longest": {"type": "integer", "minimum": 0},
            "lastActivityDate": {"type": "string"}}}}},
)

# ref-journal-draft: write-behind draft token (proven harness-draft-token-v1 shape).
FORMATIONS["ref-journal-draft"] = (
    token_cfg("ref-journal-draft", "draftId",
              {"autoCache": True, "cacheTTL": "30s", "writeDelay": "30s", "wireOpDelayMs": 100,
               "expirationMode": "fixed", "expirationDuration": "24h"}),
    {"type": "object", "additionalProperties": True, "required": ["draftId", "userId"], "properties": {
        "draftId": {"type": "string"}, "userId": {"type": "string"}, "title": {"type": "string"},
        "body": {"type": "string"}, "ciphertext": {"type": "string"}, "encrypted": {"type": "boolean"},
        "tags": {"type": "array", "items": {"type": "string"}}}},
)

# ref-tags: per-scope tag ledger token (composite scopeKey gives journal/workout isolation).
FORMATIONS["ref-tags"] = (
    token_cfg("ref-tags", "tagScopeId", {"expirationMode": "none", "autoCache": True, "cacheTTL": "1h"}),
    {"type": "object", "additionalProperties": True, "required": ["tagScopeId", "userId", "scope", "tags"], "properties": {
        "tagScopeId": {"type": "string"}, "userId": {"type": "string"},
        "scope": {"type": "string", "enum": ["journal", "workout"]},
        "tags": {"type": "array", "items": {"type": "string"}, "uniqueItems": True}}},
)

# ref-workout-session: in-progress session token (recycle).
FORMATIONS["ref-workout-session"] = (
    token_cfg("ref-workout-session", "sessionId",
              {"expirationMode": "recycle", "expirationDuration": "24h", "autoCache": True, "cacheTTL": "1h"}),
    {"type": "object", "additionalProperties": True, "required": ["sessionId", "userId", "status", "startedAt"], "properties": {
        "sessionId": {"type": "string"}, "userId": {"type": "string"}, "status": {"type": "string"},
        "startedAt": {"type": "string"}, "currentCategoryId": {"type": "string"},
        "setNumber": {"type": "integer"}, "completedCategoryIds": {"type": "array", "items": {"type": "string"}}}},
)

# ref-journal: standard SQL journal (authorName not author; allOf encrypted->ciphertext else body).
FORMATIONS["ref-journal"] = (
    std_cfg("ref-journal", "entryId", [
        ptr("by-id", "indexes/ref-journal/by-id/{{.entryId}}/latest.json"),
        ptr("by-author", "indexes/ref-journal/by-author/{{.authorName}}/{{.entryId}}/latest.json",
            desc("ref-journal", "by-author", "{{.authorName}}",
                 ["entryId", "authorName", "title", "encrypted", "tags", "updatedAt", "revisionNote"])),
        ptr("by-update", "indexes/ref-journal/by-update/{{.entryId}}/latest.json",
            desc("ref-journal", "by-update", "",
                 ["entryId", "authorName", "title", "encrypted", "tags", "updatedAt", "revisionNote"], per_scope=False)),
    ], sql_block("by-update")),
    {"type": "object", "additionalProperties": False,
     "required": ["entryId", "authorName", "title", "encrypted", "tags", "createdAt", "updatedAt"], "properties": {
        "entryId": {"type": "string", "format": "uuid"}, "authorName": {"type": "string", "minLength": 1},
        "title": {"type": "string"}, "body": {"type": "string"}, "encrypted": {"type": "boolean"},
        "ciphertext": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string"}, "uniqueItems": True},
        "createdAt": {"type": "string", "format": "date-time"}, "updatedAt": {"type": "string", "format": "date-time"},
        "revisionNote": {"type": "string"}},
     "allOf": [{"if": {"properties": {"encrypted": {"const": True}}, "required": ["encrypted"]},
                "then": {"required": ["ciphertext"]}, "else": {"required": ["body"]}}]},
)

# ref-workout-categories: standard, per-user category tree (by-parent includes userId).
FORMATIONS["ref-workout-categories"] = (
    std_cfg("ref-workout-categories", "categoryId", [
        ptr("by-id", "indexes/ref-workout-categories/by-id/{{.categoryId}}/latest.json"),
        ptr("by-parent", "indexes/ref-workout-categories/by-parent/{{.userId}}/{{.parentId}}/{{.categoryId}}/latest.json"),
    ]),
    {"type": "object", "additionalProperties": False,
     "required": ["categoryId", "userId", "parentId", "name", "metricSchema"], "properties": {
        "categoryId": {"type": "string", "format": "uuid"}, "userId": {"type": "string"},
        "parentId": {"type": "string"}, "name": {"type": "string", "minLength": 1},
        "categoryPath": {"type": "string"}, "sortOrder": {"type": "integer"},
        "metricSchema": {"type": "object", "additionalProperties": True, "required": ["fields"], "properties": {
            "fields": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
            "chartHint": {"type": "string"}, "benchmarkable": {"type": "boolean"}}}}},
)

# ref-workout-sets: standard SQL, typed metric columns + free-form metrics JSON + benchmark desc.
FORMATIONS["ref-workout-sets"] = (
    std_cfg("ref-workout-sets", "setId", [
        ptr("by-id", "indexes/ref-workout-sets/by-id/{{.setId}}/latest.json"),
        ptr("by-category", "indexes/ref-workout-sets/by-category/{{.categoryId}}/latest.json",
            desc("ref-workout-sets", "by-category", "{{.categoryId}}",
                 ["setId", "userId", "categoryId", "categoryName", "categoryPath", "isBenchmark", "recordedAt"])),
        ptr("by-benchmark", "indexes/ref-workout-sets/by-benchmark/{{.userId}}/{{.dropletId}}/latest.json",
            desc("ref-workout-sets", "by-benchmark", "{{.userId}}",
                 ["setId", "categoryId", "categoryName", "categoryPath", "recordedAt"]),
            condition="isBenchmark == true"),
        ptr("by-update", "indexes/ref-workout-sets/by-update/{{.setId}}/latest.json",
            desc("ref-workout-sets", "by-update", "",
                 ["setId", "userId", "categoryId", "categoryName", "categoryPath", "isBenchmark", "recordedAt"], per_scope=False)),
    ], sql_block("by-update")),
    {"type": "object", "additionalProperties": False,
     "required": ["setId", "userId", "sessionId", "categoryId", "categoryName", "categoryPath", "isBenchmark", "recordedAt"],
     "properties": {
        "setId": {"type": "string", "format": "uuid"}, "userId": {"type": "string"}, "sessionId": {"type": "string"},
        "categoryId": {"type": "string"}, "categoryName": {"type": "string"}, "categoryPath": {"type": "string"},
        "weightKg": {"type": ["number", "null"], "minimum": 0}, "reps": {"type": ["integer", "null"], "minimum": 0},
        "distanceM": {"type": ["number", "null"], "minimum": 0}, "durationS": {"type": ["number", "null"], "minimum": 0},
        "avgHeartRateBpm": {"type": ["number", "null"], "minimum": 0}, "elevationM": {"type": ["number", "null"]},
        "rpe": {"type": ["number", "null"], "minimum": 0, "maximum": 10},
        "metrics": {"type": "object", "additionalProperties": True}, "isBenchmark": {"type": "boolean"},
        "recordedAt": {"type": "string", "format": "date-time"}}},
)

# ref-photos: standard, revisions:true float (versioned progress photos).
FORMATIONS["ref-photos"] = (
    std_cfg("ref-photos", "photoId", [
        ptr("by-id", "indexes/ref-photos/by-id/{{.photoId}}/latest.json"),
        ptr("by-user", "indexes/ref-photos/by-user/{{.userId}}/{{.photoId}}/latest.json",
            desc("ref-photos", "by-user", "{{.userId}}", ["photoId", "userId", "caption", "capturedAt"])),
    ], {"floatConfig": {"enabled": True, "fields": [{
        "sourceField": "image", "contentTypeField": "imageContentType", "filenameField": "imageFilename",
        "pathTemplate": "floats/ref-photos/{{.photoId}}/{{.imageFilename}}", "stripAfterFloat": True,
        "downloadDisposition": "inline", "revisions": True}]}}),
    {"type": "object", "additionalProperties": False,
     "required": ["photoId", "userId", "imageContentType", "imageFilename", "capturedAt"], "properties": {
        "photoId": {"type": "string", "format": "uuid"}, "userId": {"type": "string"}, "caption": {"type": "string"},
        "capturedAt": {"type": "string", "format": "date-time"}, "image": {"type": "string", "contentEncoding": "base64"},
        "imageContentType": {"type": "string"}, "imageFilename": {"type": "string"}}},
)


def main():
    for fid, (cfg, schema) in FORMATIONS.items():
        with open(os.path.join(HERE, f"{fid}-config.json"), "w") as fh:
            json.dump(cfg, fh, indent=2)
            fh.write("\n")
        with open(os.path.join(HERE, f"{fid}-schema.json"), "w") as fh:
            json.dump(schema, fh, indent=2)
            fh.write("\n")
        print(f"wrote {fid}")
    print(f"\n{len(FORMATIONS)} formations emitted (+ ref-users, ref-entries authored by hand)")


if __name__ == "__main__":
    main()
