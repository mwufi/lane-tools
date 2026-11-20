import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const convoKey = (a: string, b: string) => [a, b].sort().join("|");

export const thread = query({
  args: { a: v.string(), b: v.string() },
  handler: async (ctx, { a, b }) => {
    const latest = await ctx.db
      .query("messages")
      .withIndex("by_convo", (q) => q.eq("convo", convoKey(a, b)))
      .order("desc")
      .take(50);
    return latest.reverse();
  },
});

// Demo app with fictional people: no auth, so anyone can post as anyone.
export const send = mutation({
  args: { from: v.string(), to: v.string(), body: v.string() },
  handler: async (ctx, { from, to, body }) => {
    const text = body.trim().slice(0, 500);
    if (!text) throw new Error("empty message");
    return await ctx.db.insert("messages", { convo: convoKey(from, to), from, to, body: text });
  },
});
