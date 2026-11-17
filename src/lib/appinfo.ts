import { isTauri } from "./tauri";

export const APP_NAME = "helmcode";
export const APP_AUTHOR = "Francesco Flora";
export const GITHUB_URL = "https://github.com/francescoflora/helmcode";
export const RELEASES_URL = `${GITHUB_URL}/releases/latest`;
export const APP_VERSION_FALLBACK = "0.1.0";

export async function getAppVersion(): Promise<string> {
  if (isTauri()) {
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      return await getVersion();
    } catch {
      /* fall through */
    }
  }
  return APP_VERSION_FALLBACK;
}
