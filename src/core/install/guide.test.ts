import { describe, expect, test } from "bun:test";
import {
  detectInstallPlatform,
  INSTALL_SEEN_KEY,
  INSTALL_SEEN_VALUE,
  installGuide,
  readSeenMark,
  shouldAutoShow,
  writeSeenMark,
  type InstallPlatform,
  type SeenStorage,
} from "./guide";

// Real user agents, one per case the steps differ for.
const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  iphoneSafariOld:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1",
  ipadSafariMobile:
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  // iPadOS Safari asks for desktop sites by default and reports as a Mac.
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.7444.77 Mobile/15E148 Safari/604.1",
  iphoneFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15",
  iphoneEdge:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/141.0.3537.71 Mobile/15E148 Safari/605.1.15",
  iphoneInstagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 405.0.0.21.76 (iPhone16,2; iOS 18_6; en_US; en; scale=3.00; 1290x2796; 800000000)",
  iphoneFacebook:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/530.0.0.40.108;FBBV/800000000;FBDV/iPhone16,2;FBMD/iPhone;FBSN/iOS;FBSV/18.6;FBSS/3;FBLC/en_US;FBOP/80]",
  iphoneBareWebView: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  iphoneGoogleApp:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/390.0.800000000 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0",
  androidSamsung:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
  androidEdge:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0",
  androidWebView:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.241005.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36",
  androidInstagram:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.241005.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36 Instagram 405.0.0.21.76 Android",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  windowsFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0",
  chromeOs: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
};

function detect(userAgent: string, maxTouchPoints = 0): InstallPlatform {
  return detectInstallPlatform({ userAgent, maxTouchPoints });
}

describe("detectInstallPlatform", () => {
  test("iPhone and iPad Safari", () => {
    expect(detect(UA.iphoneSafari, 5)).toEqual({ kind: "ios-safari" });
    expect(detect(UA.iphoneSafariOld, 5)).toEqual({ kind: "ios-safari" });
    expect(detect(UA.ipadSafariMobile, 5)).toEqual({ kind: "ios-safari" });
  });

  test("an iPad that reports as a Mac is told apart by its touch points", () => {
    expect(detect(UA.macSafari, 5)).toEqual({ kind: "ios-safari" });
    expect(detect(UA.macSafari, 0)).toEqual({ kind: "desktop", browser: "safari" });
    // A Mac with one touch point (some trackpads report 1) is still a Mac.
    expect(detect(UA.macSafari, 1)).toEqual({ kind: "desktop", browser: "safari" });
  });

  test("other browsers on iOS are named", () => {
    expect(detect(UA.iphoneChrome, 5)).toEqual({ kind: "ios-browser", name: "Chrome" });
    expect(detect(UA.iphoneFirefox, 5)).toEqual({ kind: "ios-browser", name: "Firefox" });
    expect(detect(UA.iphoneEdge, 5)).toEqual({ kind: "ios-browser", name: "Edge" });
  });

  test("a page inside another app on iOS", () => {
    expect(detect(UA.iphoneInstagram, 5)).toEqual({ kind: "ios-in-app" });
    expect(detect(UA.iphoneFacebook, 5)).toEqual({ kind: "ios-in-app" });
    expect(detect(UA.iphoneBareWebView, 5)).toEqual({ kind: "ios-in-app" });
    // The Google app adds a Safari token, so it is matched by name.
    expect(detect(UA.iphoneGoogleApp, 5)).toEqual({ kind: "ios-in-app" });
  });

  test("Android browsers", () => {
    expect(detect(UA.androidChrome, 5)).toEqual({ kind: "android-chrome" });
    expect(detect(UA.androidFirefox, 5)).toEqual({ kind: "android-firefox" });
    // These carry a Chrome token too, and must not be taken for Chrome.
    expect(detect(UA.androidSamsung, 5)).toEqual({ kind: "android-browser" });
    expect(detect(UA.androidEdge, 5)).toEqual({ kind: "android-browser" });
  });

  test("a page inside another app on Android", () => {
    expect(detect(UA.androidWebView, 5)).toEqual({ kind: "android-in-app" });
    expect(detect(UA.androidInstagram, 5)).toEqual({ kind: "android-in-app" });
  });

  test("computers", () => {
    expect(detect(UA.windowsChrome)).toEqual({ kind: "desktop", browser: "chromium" });
    expect(detect(UA.windowsEdge)).toEqual({ kind: "desktop", browser: "chromium" });
    expect(detect(UA.macChrome)).toEqual({ kind: "desktop", browser: "chromium" });
    expect(detect(UA.chromeOs)).toEqual({ kind: "desktop", browser: "chromium" });
    expect(detect(UA.windowsFirefox)).toEqual({ kind: "desktop", browser: "other" });
    expect(detect(UA.linuxFirefox)).toEqual({ kind: "desktop", browser: "other" });
  });

  test("a touch-screen Windows laptop is still a computer", () => {
    expect(detect(UA.windowsChrome, 10)).toEqual({ kind: "desktop", browser: "chromium" });
  });

  test("an Android tablet, or a phone asking for the desktop site, is told apart by its touch points", () => {
    // Chrome on a large Android tablet sends this by default: a Linux desktop user agent with no Android token.
    const linuxChrome =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
    expect(detect(linuxChrome, 5)).toEqual({ kind: "android-chrome" });
    expect(installGuide(detect(linuxChrome, 5)).title).not.toContain("phone");
    // No touch: a Linux computer.
    expect(detect(linuxChrome, 0)).toEqual({ kind: "desktop", browser: "chromium" });
    expect(detect(linuxChrome, 1)).toEqual({ kind: "desktop", browser: "chromium" });
    // Firefox for Android in desktop mode.
    expect(detect(UA.linuxFirefox, 5)).toEqual({ kind: "android-firefox" });
    // Edge keeps its token in desktop mode and must not be taken for Chrome.
    expect(detect(`${linuxChrome} Edg/142.0.0.0`, 5)).toEqual({ kind: "android-browser" });
    // A Chromebook has a touch screen and is still a computer.
    expect(detect(UA.chromeOs, 10)).toEqual({ kind: "desktop", browser: "chromium" });
  });

  test("anything it can't place is unknown", () => {
    expect(detect("")).toEqual({ kind: "unknown" });
    expect(detect("SomeBot/1.0")).toEqual({ kind: "unknown" });
    expect(detect("Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15")).toEqual({ kind: "unknown" });
  });
});

function allText(platform: InstallPlatform): string {
  const guide = installGuide(platform);
  return [guide.title, guide.intro, ...guide.sections.flatMap((s) => [s.heading ?? "", ...s.steps.map((x) => x.text), s.note ?? ""])].join("\n");
}

describe("installGuide", () => {
  test("iOS Safari: Share, Add to Home Screen, Add, covering both Safari layouts", () => {
    const guide = installGuide({ kind: "ios-safari" });
    expect(guide.sections).toHaveLength(1);
    const steps = guide.sections[0]!.steps.map((s) => s.text);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain("**Share**");
    // The newer layout keeps Share inside the page menu.
    expect(steps[0]).toContain("**···**");
    expect(steps[1]).toContain("**Add to Home Screen**");
    expect(steps[2]).toContain("**Add**");
    expect(guide.canOfferPrompt).toBe(false);
  });

  test("iOS Chrome, Firefox, and Edge name their own browser and fall back to Safari", () => {
    for (const name of ["Chrome", "Firefox", "Edge"] as const) {
      const text = allText({ kind: "ios-browser", name });
      expect(text).toContain(name);
      expect(text).toContain("**Add to Home Screen**");
      expect(text).toContain("Safari");
      expect(installGuide({ kind: "ios-browser", name }).canOfferPrompt).toBe(false);
    }
  });

  test("inside another app, the first step is to leave it for a real browser", () => {
    const ios = installGuide({ kind: "ios-in-app" });
    expect(ios.sections[0]!.steps[0]!.text).toContain("Open this page in Safari");
    expect(ios.canOfferPrompt).toBe(false);
    const android = installGuide({ kind: "android-in-app" });
    expect(android.sections[0]!.steps[0]!.text).toContain("Open this page in Chrome");
    expect(android.canOfferPrompt).toBe(false);
  });

  test("Android Chrome has written steps and may offer the real prompt", () => {
    const guide = installGuide({ kind: "android-chrome" });
    const text = guide.sections[0]!.steps.map((s) => s.text).join(" ");
    // Google's current label first, then the older ones.
    expect(text).toContain("**Install and create shortcut**");
    expect(text).toContain("**Add to Home screen**");
    // A Chrome tab inside another app looks like Chrome and has no install item.
    expect(guide.sections[0]!.note).toContain("Open in Chrome");
    expect(guide.canOfferPrompt).toBe(true);
  });

  test("Safari on a Mac says which macOS has Add to Dock", () => {
    expect(installGuide({ kind: "desktop", browser: "safari" }).sections[0]!.note).toContain("Sonoma");
  });

  test("Android Firefox never offers the prompt, other Android browsers may", () => {
    expect(installGuide({ kind: "android-firefox" }).canOfferPrompt).toBe(false);
    expect(allText({ kind: "android-firefox" })).toContain("Firefox");
    expect(installGuide({ kind: "android-browser" }).canOfferPrompt).toBe(true);
  });

  test("unknown shows both phones' steps under headings", () => {
    const guide = installGuide({ kind: "unknown" });
    expect(guide.sections.map((s) => s.heading)).toEqual(["iPhone or iPad", "Android"]);
    expect(guide.sections.every((s) => s.steps.length === 3)).toBe(true);
  });

  test("a computer is pointed at the phone, with its own way where one exists", () => {
    const chromium = installGuide({ kind: "desktop", browser: "chromium" });
    expect(chromium.title).toContain("phone");
    expect(chromium.sections).toHaveLength(1);
    expect(chromium.canOfferPrompt).toBe(true);
    const safari = installGuide({ kind: "desktop", browser: "safari" });
    expect(safari.sections[0]!.steps[0]!.text).toContain("**Add to Dock**");
    expect(safari.canOfferPrompt).toBe(false);
    const other = installGuide({ kind: "desktop", browser: "other" });
    expect(other.sections).toHaveLength(0);
    expect(other.canOfferPrompt).toBe(false);
  });

  test("bold markers always pair up, so the UI never prints a stray **", () => {
    const platforms: InstallPlatform[] = [
      { kind: "ios-safari" },
      { kind: "ios-browser", name: "Chrome" },
      { kind: "ios-browser", name: "Firefox" },
      { kind: "ios-browser", name: "Edge" },
      { kind: "ios-in-app" },
      { kind: "android-chrome" },
      { kind: "android-firefox" },
      { kind: "android-browser" },
      { kind: "android-in-app" },
      { kind: "desktop", browser: "chromium" },
      { kind: "desktop", browser: "safari" },
      { kind: "desktop", browser: "other" },
      { kind: "unknown" },
    ];
    for (const platform of platforms) {
      const guide = installGuide(platform);
      expect(guide.title.length).toBeGreaterThan(0);
      expect(guide.intro.length).toBeGreaterThan(0);
      for (const section of guide.sections) {
        for (const step of section.steps) {
          expect((step.text.match(/\*\*/g) ?? []).length % 2).toBe(0);
        }
      }
    }
  });
});

/** A stand-in for the browser's Storage, with switches for the ways a real one fails. */
function fakeStorage(options: { readThrows?: boolean; writeThrows?: boolean; initial?: Record<string, string> } = {}) {
  const items = new Map(Object.entries(options.initial ?? {}));
  const storage: SeenStorage = {
    getItem(key) {
      if (options.readThrows) throw new Error("blocked");
      return items.get(key) ?? null;
    },
    setItem(key, value) {
      if (options.writeThrows) throw new Error("QuotaExceededError");
      items.set(key, value);
    },
    removeItem(key) {
      items.delete(key);
    },
  };
  return { storage, items };
}

describe("the seen mark", () => {
  test("a working storage: unmarked, then marked, and the test write leaves nothing behind", () => {
    const { storage, items } = fakeStorage();
    expect(readSeenMark(storage)).toBe(false);
    expect(items.size).toBe(0);
    expect(writeSeenMark(storage)).toBe(true);
    expect(items.get(INSTALL_SEEN_KEY)).toBe(INSTALL_SEEN_VALUE);
    expect(readSeenMark(storage)).toBe(true);
  });

  test("a storage that reads but refuses writes can't remember, so the prompt never opens by itself", () => {
    const { storage } = fakeStorage({ writeThrows: true });
    expect(readSeenMark(storage)).toBe(null);
    expect(shouldAutoShow({ standalone: false, seen: readSeenMark(storage) })).toBe(false);
    // The dismissal is lost without an error, and the next load still stays quiet.
    expect(writeSeenMark(storage)).toBe(false);
    expect(shouldAutoShow({ standalone: false, seen: readSeenMark(storage) })).toBe(false);
  });

  test("a mark already there is read even when writes are refused", () => {
    const { storage } = fakeStorage({ writeThrows: true, initial: { [INSTALL_SEEN_KEY]: INSTALL_SEEN_VALUE } });
    expect(readSeenMark(storage)).toBe(true);
  });

  test("a storage that can't be read at all", () => {
    const { storage } = fakeStorage({ readThrows: true });
    expect(readSeenMark(storage)).toBe(null);
  });
});

describe("shouldAutoShow", () => {
  test("shows once, in a browser tab, on a device that hasn't seen it", () => {
    expect(shouldAutoShow({ standalone: false, seen: false })).toBe(true);
  });

  test("never from the home screen", () => {
    expect(shouldAutoShow({ standalone: true, seen: false })).toBe(false);
    expect(shouldAutoShow({ standalone: true, seen: true })).toBe(false);
    expect(shouldAutoShow({ standalone: true, seen: null })).toBe(false);
  });

  test("never again once seen", () => {
    expect(shouldAutoShow({ standalone: false, seen: true })).toBe(false);
  });

  test("not when the device can't remember a dismissal", () => {
    expect(shouldAutoShow({ standalone: false, seen: null })).toBe(false);
  });
});
