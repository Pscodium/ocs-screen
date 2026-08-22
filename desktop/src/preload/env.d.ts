import type { ScreenShareApi } from "./index";

declare global {
  interface Window {
    screenshare: ScreenShareApi;
  }
}
