import { createPiBrowserExtension } from "@zamery/pi-browser";

export const extension = createPiBrowserExtension({
  workspaceRoot: process.cwd(),
  config: {
    provider_module: "@zamery/browser-firefox",
  },
});
