import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  friends: defineTable({
    handle: v.string(),
    name: v.string(),
    emoji: v.string(),
  }).index("by_handle", ["handle"]),

  messages: defineTable({
    convo: v.string(), // the two handles, sorted and joined with "|"
    from: v.string(),
    to: v.string(),
    body: v.string(),
  }).index("by_convo", ["convo"]),
});
