import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Log a developer event
export const log = mutation({
  args: {
    level: v.union(v.literal("info"), v.literal("warn"), v.literal("error")),
    message: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("devLogs", {
      level: args.level,
      message: args.message,
      metadata: args.metadata,
      timestamp: Date.now(),
    });
  },
});

// Get recent logs
export const getRecentLogs = query({
  args: {
    limit: v.optional(v.number()),
    level: v.optional(v.union(v.literal("info"), v.literal("warn"), v.literal("error"))),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    let logsQuery = ctx.db.query("devLogs").order("desc");

    const logs = await logsQuery.take(limit);

    if (args.level) {
      return logs.filter((log) => log.level === args.level);
    }

    return logs;
  },
});

// Clear old logs (keep last N days)
export const clearOldLogs = mutation({
  args: {
    daysToKeep: v.number(),
  },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.daysToKeep * 24 * 60 * 60 * 1000;
    const oldLogs = await ctx.db
      .query("devLogs")
      .withIndex("by_timestamp", (q) => q.lt("timestamp", cutoff))
      .collect();

    for (const log of oldLogs) {
      await ctx.db.delete(log._id);
    }

    return { deleted: oldLogs.length };
  },
});
