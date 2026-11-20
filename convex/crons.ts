import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("archive dormant lanes", { hours: 6 }, internal.lanes.sweepDormant, {});
export default crons;
