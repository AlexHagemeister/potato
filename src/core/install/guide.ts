// How to add Potato to the home screen, by device and browser (issue 138).
// Pure: the browser's user agent and touch-point count go in, the steps to
// show come out. No browser APIs here, so every case has a unit test.
//
// The mechanics come from the browsers' own documentation, read 2026-11-26:
// - iPhone and iPad, Safari: Share (inside the page menu on the newer layout),
//   then Add to Home Screen, then Add, with Open as Web App left on.
//   https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios
// - iPhone and iPad, other browsers: since iOS 16.4 a browser can offer Add to
//   Home Screen in its Share menu, but only an app with Apple's browser
//   entitlement. A page opened inside another app (a web view) has no such item.
//   https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
//   https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable
//   https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DiOS
// - Android: Chromium browsers can fire beforeinstallprompt, which gives the
//   page a real Install button, but only after some use of the page. The menu
//   item's name varies ("Add to Home screen", "Install app"). Firefox has no
//   such event and adds from its menu.
//   https://web.dev/articles/install-criteria
//   https://web.dev/learn/pwa/installation
//   https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeinstallprompt_event
//   https://support.mozilla.org/en-US/kb/use-web-apps-firefox-android
// - Computers: Chrome and Edge install from the address bar. Safari on macOS 14
//   or later has File > Add to Dock. Firefox has neither.
//   https://support.apple.com/en-us/104996

/** Where the page is running, as far as the user agent can tell. */
export type InstallPlatform =
  | { kind: "ios-safari" }
  /** A browser app on iOS that can offer Add to Home Screen in its Share menu. */
  | { kind: "ios-browser"; name: "Chrome" | "Firefox" | "Edge" }
  /** A page opened inside another app on iOS (a link tapped in a messaging or social app). */
  | { kind: "ios-in-app" }
  | { kind: "android-chrome" }
  | { kind: "android-firefox" }
  /** Another Android browser: Samsung Internet, Edge, Opera, and the rest. */
  | { kind: "android-browser" }
  /** A page opened inside another app on Android (a web view). */
  | { kind: "android-in-app" }
  | { kind: "desktop"; browser: "chromium" | "safari" | "other" }
  | { kind: "unknown" };

export interface PlatformInput {
  userAgent: string;
  /** navigator.maxTouchPoints. An iPad's Safari says it is a Mac; only this tells them apart. */
  maxTouchPoints: number;
}

// Apps that open links in their own web view and say so in the user agent.
const IN_APP_TOKENS =
  /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Line\/|MicroMessenger|Twitter|TikTok|musical_ly|BytedanceWebview|Snapchat|LinkedInApp|Pinterest|GSA\/|Slack|Discord|WhatsApp|Telegram|KAKAOTALK/i;

/** Sorts a user agent into the platforms whose steps differ. Anything it can't place is "unknown". */
export function detectInstallPlatform({ userAgent, maxTouchPoints }: PlatformInput): InstallPlatform {
  const ua = userAgent;
  if (!ua) return { kind: "unknown" };

  const iPadAsMac = /Macintosh/.test(ua) && maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(ua) || iPadAsMac) {
    if (/CriOS\//.test(ua)) return { kind: "ios-browser", name: "Chrome" };
    if (/FxiOS\//.test(ua)) return { kind: "ios-browser", name: "Firefox" };
    if (/EdgiOS\//.test(ua)) return { kind: "ios-browser", name: "Edge" };
    // A bare web view sends no "Safari/" token. Known apps are matched by name, since some add the token.
    if (IN_APP_TOKENS.test(ua) || !/Safari\//.test(ua)) return { kind: "ios-in-app" };
    return { kind: "ios-safari" };
  }

  if (/Android/.test(ua)) {
    // "; wv)" is Android's own mark for a web view.
    if (/; wv\)/.test(ua) || IN_APP_TOKENS.test(ua)) return { kind: "android-in-app" };
    if (/Firefox\//.test(ua)) return { kind: "android-firefox" };
    if (/SamsungBrowser\/|EdgA\/|OPR\/|OPT\/|YaBrowser\/|DuckDuckGo\//.test(ua)) return { kind: "android-browser" };
    if (/Chrome\//.test(ua)) return { kind: "android-chrome" };
    return { kind: "android-browser" };
  }

  if (/Windows NT|Macintosh|CrOS|X11|Linux/.test(ua)) {
    if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return { kind: "desktop", browser: "chromium" };
    if (/Macintosh/.test(ua) && /Safari\//.test(ua) && /Version\//.test(ua)) return { kind: "desktop", browser: "safari" };
    return { kind: "desktop", browser: "other" };
  }

  return { kind: "unknown" };
}

/** A small picture of the control a step names, drawn by the UI. */
export type StepIcon = "share" | "add" | "dots-vertical" | "open-out" | "install";

export interface InstallStep {
  /** Plain text. A control's name is wrapped in ** so the UI can set it in bold. */
  text: string;
  icon?: StepIcon;
}

export interface InstallSection {
  /** Set when the guide has more than one set of steps. */
  heading?: string;
  steps: InstallStep[];
  /** A fallback line under the steps. */
  note?: string;
}

export interface InstallGuide {
  title: string;
  intro: string;
  sections: InstallSection[];
  /**
   * Whether this browser can hand the page a real install prompt (beforeinstallprompt). The UI shows its Install
   * button only when this is true and the browser has actually fired the event.
   */
  canOfferPrompt: boolean;
}

const TITLE = "Add Potato to your Home Screen";
const INTRO = "It opens full screen, like an app, straight to your deck.";

const IOS_SAFARI_STEPS: InstallStep[] = [
  { text: "Tap **Share** in Safari's toolbar. If it isn't there, tap **···** first, then **Share**.", icon: "share" },
  { text: "Scroll down the list and tap **Add to Home Screen**.", icon: "add" },
  { text: "Tap **Add**. If you see **Open as Web App**, leave it on." },
];
const IOS_SAFARI_NOTE = "No Add to Home Screen in the list? Scroll to the bottom, tap Edit Actions, and add it.";

const ANDROID_CHROME_STEPS: InstallStep[] = [
  { text: "Tap **⋮** at the top right of Chrome.", icon: "dots-vertical" },
  { text: "Tap **Add to Home screen**. Chrome may call it **Install app**.", icon: "install" },
  { text: "Tap **Install**." },
];

/** The steps to show for a platform. Every platform gets a guide; "unknown" gets both phones' steps. */
export function installGuide(platform: InstallPlatform): InstallGuide {
  switch (platform.kind) {
    case "ios-safari":
      return {
        title: TITLE,
        intro: INTRO,
        sections: [{ steps: IOS_SAFARI_STEPS, note: IOS_SAFARI_NOTE }],
        canOfferPrompt: false,
      };
    case "ios-browser":
      return {
        title: TITLE,
        intro: INTRO,
        sections: [
          {
            steps: [
              platform.name === "Chrome"
                ? { text: "Tap **Share** at the right of Chrome's address bar.", icon: "share" }
                : { text: `Open ${platform.name}'s menu and tap **Share**.`, icon: "share" },
              { text: "Find and tap **Add to Home Screen**.", icon: "add" },
              { text: "Tap **Add**." },
            ],
            note: "No Add to Home Screen in the list? Open this page in Safari and add it from there.",
          },
        ],
        canOfferPrompt: false,
      };
    case "ios-in-app":
      return {
        title: TITLE,
        intro: "This page is open inside another app, which can't add it. Safari can.",
        sections: [
          {
            steps: [
              { text: "Open this page in Safari. Look for **Open in Safari** or **Open in Browser** in this app's menu.", icon: "open-out" },
              { text: "In Safari, tap **Share**, then **Add to Home Screen**.", icon: "share" },
              { text: "Tap **Add**." },
            ],
          },
        ],
        canOfferPrompt: false,
      };
    case "android-chrome":
      return { title: TITLE, intro: INTRO, sections: [{ steps: ANDROID_CHROME_STEPS }], canOfferPrompt: true };
    case "android-firefox":
      return {
        title: TITLE,
        intro: INTRO,
        sections: [
          {
            steps: [
              { text: "Tap **⋮** to open Firefox's menu.", icon: "dots-vertical" },
              { text: "Tap **Add to Home screen**. Firefox may call it **Add app to Home screen**.", icon: "install" },
              { text: "Tap **Add automatically**, or drag the icon where you want it." },
            ],
          },
        ],
        canOfferPrompt: false,
      };
    case "android-browser":
      return {
        title: TITLE,
        intro: INTRO,
        sections: [
          {
            steps: [
              { text: "Open your browser's menu (**⋮** or **≡**).", icon: "dots-vertical" },
              { text: "Tap **Add to Home screen**. Your browser may call it **Install app**.", icon: "install" },
              { text: "Confirm with **Install** or **Add**." },
            ],
          },
        ],
        canOfferPrompt: true,
      };
    case "android-in-app":
      return {
        title: TITLE,
        intro: "This page is open inside another app, which can't add it. Chrome can.",
        sections: [
          {
            steps: [
              { text: "Open this page in Chrome. Tap **⋮**, then **Open in Chrome** or **Open in browser**.", icon: "open-out" },
              { text: "In Chrome, tap **⋮**, then **Add to Home screen**.", icon: "install" },
              { text: "Tap **Install**." },
            ],
          },
        ],
        canOfferPrompt: false,
      };
    case "desktop": {
      const here: Record<typeof platform.browser, InstallSection[]> = {
        chromium: [
          {
            heading: "On this computer",
            steps: [{ text: "Click the install icon at the right of the address bar, then **Install**.", icon: "install" }],
          },
        ],
        safari: [
          {
            heading: "On this Mac",
            steps: [{ text: "In the menu bar, choose **File**, then **Add to Dock**.", icon: "add" }],
          },
        ],
        other: [],
      };
      return {
        title: "Potato is made for your phone",
        intro: "Open this page on your phone and sign in. It shows you how to add Potato to your home screen there.",
        sections: here[platform.browser],
        canOfferPrompt: platform.browser === "chromium",
      };
    }
    case "unknown":
      return {
        title: TITLE,
        intro: INTRO,
        sections: [
          { heading: "iPhone or iPad", steps: IOS_SAFARI_STEPS },
          { heading: "Android", steps: ANDROID_CHROME_STEPS },
        ],
        // If the browser does fire the event, the button is real, so allow it.
        canOfferPrompt: true,
      };
  }
}

/** The key the device keeps the "already shown" mark under (localStorage). */
export const INSTALL_SEEN_KEY = "potato.install-prompt.v1";
export const INSTALL_SEEN_VALUE = "seen";

export interface AutoShowInput {
  /** The app is running from the home screen already. */
  standalone: boolean;
  /** Whether this device has the mark. null when storage can't be read. */
  seen: boolean | null;
}

/**
 * Whether the prompt opens by itself. Never from the home screen, never twice on one device, and not when the
 * device can't remember a dismissal (it would come back on every load). The steps stay on the Profile tab.
 */
export function shouldAutoShow({ standalone, seen }: AutoShowInput): boolean {
  return !standalone && seen === false;
}
