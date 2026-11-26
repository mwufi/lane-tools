import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("archive dormant lanes", { hours: 6 }, internal.lanes.sweepDormant, {});
crons.interval("refill warm pools", { minutes: 10 }, internal.pool.refill, {});
export default crons;
