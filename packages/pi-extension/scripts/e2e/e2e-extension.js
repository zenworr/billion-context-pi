import { createAcpExtension } from "../../dist/index.js";

export default createAcpExtension({
  preserveRecentMessages: 0,
  preserveRecentTokens: 0,
  preserveLastUserMessage: false,
  coreOverrides: {
    compress: {
      minCompressRange: 500,
      minSummaryLength: 10,
    },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    preserveLastUserMessage: false,
  },
});
