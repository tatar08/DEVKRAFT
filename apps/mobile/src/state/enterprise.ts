import { createEnterpriseEnvironmentAtoms } from "@t3tools/client-runtime/state/enterprise";

import { connectionAtomRuntime } from "../connection/runtime";

/** Use the mobile registry so approvals follow the destination environment's grants. */
export const enterpriseEnvironment = createEnterpriseEnvironmentAtoms(connectionAtomRuntime);
