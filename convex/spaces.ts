import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Record when a space is created
export const recordSpaceCreated = mutation({
  args: {
    spaceId: v.string(),
    createdBy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("spaces", {
      spaceId: args.spaceId,
      createdAt: Date.now(),
      createdBy: args.createdBy,
      peakUsers: 0,
      totalMessages: 0,
      totalFiles: 0,
    });
  },
});

// Update space stats
export const updateSpaceStats = mutation({
  args: {
    spaceId: v.string(),
    peakUsers: v.optional(v.number()),
    totalMessages: v.optional(v.number()),
    totalFiles: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const space = await ctx.db
      .query("spaces")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
      .first();

    if (space) {
      await ctx.db.patch(space._id, {
        peakUsers: args.peakUsers ?? space.peakUsers,
        totalMessages: args.totalMessages ?? space.totalMessages,
        totalFiles: args.totalFiles ?? space.totalFiles,
      });
    }
  },
});

// Record when a space closes
export const recordSpaceClosed = mutation({
  args: {
    spaceId: v.string(),
  },
  handler: async (ctx, args) => {
    const space = await ctx.db
      .query("spaces")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
      .first();

    if (space) {
      const closedAt = Date.now();
      await ctx.db.patch(space._id, {
        closedAt,
        durationMs: closedAt - space.createdAt,
      });
    }
  },
});

// Get recent spaces for dashboard
export const getRecentSpaces = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    return await ctx.db
      .query("spaces")
      .order("desc")
      .take(limit);
  },
});

// Get space by ID
export const getSpace = query({
  args: {
    spaceId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("spaces")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
      .first();
  },
});

// Record meeting summary when space closes
export const recordMeetingSummary = mutation({
  args: {
    spaceId: v.string(),
    summaryMarkdown: v.string(),
  },
  handler: async (ctx, args) => {
    const space = await ctx.db
      .query("spaces")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
      .first();

    if (space) {
      const closedAt = Date.now();
      await ctx.db.patch(space._id, {
        closedAt,
        durationMs: closedAt - space.createdAt,
        summaryMarkdown: args.summaryMarkdown,
      });
      console.log(`Meeting summary saved for space ${args.spaceId}`);
    } else {
      console.warn(`Space ${args.spaceId} not found when saving summary`);
    }
  },
});
