import { internalMutation } from "./_generated/server";
import { convoKey } from "./messages";

const FRIENDS = [
  { handle: "ada", name: "Ada", emoji: "🦊" },
  { handle: "bo", name: "Bo", emoji: "🐙" },
  { handle: "cy", name: "Cy", emoji: "🦄" },
  { handle: "dee", name: "Dee", emoji: "🐢" },
  { handle: "eli", name: "Eli", emoji: "🐝" },
];

const CHATTER: Array<[string, string, string]> = [
  ["ada", "bo", "taco tuesday?? 🌮"],
  ["bo", "ada", "only if it's the place with the salsa bar"],
  ["ada", "bo", "obviously"],
  ["cy", "ada", "did you see the moon last night"],
  ["ada", "cy", "it was ENORMOUS"],
  ["dee", "eli", "slow and steady wins the race"],
  ["eli", "dee", "buzz buzz, I'm already there"],
];

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (await ctx.db.query("friends").first()) return "already seeded";
    for (const f of FRIENDS) await ctx.db.insert("friends", f);
    for (const [from, to, body] of CHATTER) {
      await ctx.db.insert("messages", { convo: convoKey(from, to), from, to, body });
    }
    return `seeded ${FRIENDS.length} friends, ${CHATTER.length} messages`;
  },
});
