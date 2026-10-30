// Type-checked by `npm run typecheck`, never run. Each @ts-expect-error fails
// the typecheck if the line below it starts compiling, which would mean a
// required option became optional.
import { Migration, type Profile } from "../../index.js";

declare const from: Profile<unknown>;
declare const to: Profile<unknown>;

// @ts-expect-error shadowWriteFailure has no default
new Migration({ from, to, phase: "from", compareRate: 1 });
// @ts-expect-error compareRate has no default
new Migration({ from, to, phase: "from", shadowWriteFailure: "throw" });
// @ts-expect-error phase has no default
new Migration({ from, to, shadowWriteFailure: "throw", compareRate: 1 });
// @ts-expect-error from is required
new Migration({ to, phase: "from", shadowWriteFailure: "throw", compareRate: 1 });
// @ts-expect-error unknown phase
new Migration({ from, to, phase: "both", shadowWriteFailure: "throw", compareRate: 1 });

new Migration({ from, to, phase: "from", shadowWriteFailure: "report", compareRate: 0.1 });
