import { createEnterpriseEnvironmentAtoms } from "@t3tools/client-runtime/state/enterprise";

import { connectionAtomRuntime } from "../connection/runtime";

/** Enterprise cockpit and approval atoms bound to the web connection runtime. */
export const enterpriseEnvironment = createEnterpriseEnvironmentAtoms(connectionAtomRuntime);
