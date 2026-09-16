import { installFirefoxNativeHost } from "@zamery/browser-firefox";

const plan = installFirefoxNativeHost({
  extensionId: "zamery-browser-firefox@zamery.local",
});

console.log(`Installed Firefox Native Messaging manifest at ${plan.manifestPath}`);
