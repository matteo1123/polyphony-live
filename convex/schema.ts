import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Developer/admin data schema - user session data stays ephemeral in Redis
export default defineSchema({
  // Track space creation analytics
  spaces: defineTable({
    spaceId: v.string(),
    createdAt: v.number(),
    createdBy: v.optional(v.string()), // IP or identifier
    peakUsers: v.number(),
    totalMessages: v.number(),
    totalFiles: v.number(),
    closedAt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
  }).index("by_spaceId", ["spaceId"]),

  // Developer event logs
  devLogs: defineTable({
    level: v.union(v.literal("info"), v.literal("warn"), v.literal("error")),
    message: v.string(),
    metadata: v.optional(v.any()),
    timestamp: v.number(),
  }).index("by_timestamp", ["timestamp"]),

  // App configuration (feature flags, settings)
  config: defineTable({
    key: v.string(),
    value: v.any(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
});
