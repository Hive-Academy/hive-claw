// Shim for `openclaw/plugin-sdk/typebox`. The plugin-sdk's typebox subpath
// is itself a re-export of `@sinclair/typebox`, so re-exporting upstream
// is API-compatible. See ./README.md for the Batch 7 cleanup plan.
export * from "@sinclair/typebox";
