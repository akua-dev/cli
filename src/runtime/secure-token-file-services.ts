import { Context } from "effect";

import type { SecureTokenFileDependencies } from "./secure-token-file";

export class SecureTokenFile extends Context.Service<
  SecureTokenFile,
  {
    readonly dependencies: SecureTokenFileDependencies;
  }
>()("platform/cli/SecureTokenFile") {}
